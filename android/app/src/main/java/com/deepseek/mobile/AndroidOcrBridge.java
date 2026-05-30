package com.deepseek.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;

import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class AndroidOcrBridge {
    private static final long OCR_TIMEOUT_SECONDS = 60;
    private static final int PDF_RENDER_SCALE = 2;
    private static final int MAX_PDF_BITMAP_PIXELS = 4_000_000;

    private static Context appContext;
    private static TextRecognizer recognizer;

    private AndroidOcrBridge() {
    }

    public static synchronized void initialize(Context context) {
        appContext = context.getApplicationContext();
    }

    public static synchronized boolean isAvailable() {
        return appContext != null;
    }

    public static String recognizeImage(byte[] imageBytes) throws Exception {
        ensureInitialized();
        Bitmap bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
        if (bitmap == null) {
            throw new IllegalArgumentException("Image bytes cannot be decoded.");
        }
        try {
            return recognizeBitmap(bitmap);
        } finally {
            bitmap.recycle();
        }
    }

    public static String recognizePdf(byte[] pdfBytes) throws Exception {
        ensureInitialized();
        File tempFile = File.createTempFile("deepseek-ocr-", ".pdf", appContext.getCacheDir());
        try (FileOutputStream output = new FileOutputStream(tempFile)) {
            output.write(pdfBytes);
        }

        StringBuilder pages = new StringBuilder();
        try (
            ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(tempFile, ParcelFileDescriptor.MODE_READ_ONLY);
            PdfRenderer renderer = new PdfRenderer(descriptor)
        ) {
            for (int index = 0; index < renderer.getPageCount(); index++) {
                PdfRenderer.Page page = renderer.openPage(index);
                Bitmap bitmap = null;
                try {
                    bitmap = renderPage(page);
                    String text = recognizeBitmap(bitmap).trim();
                    if (!text.isEmpty()) {
                        if (pages.length() > 0) {
                            pages.append("\n\n");
                        }
                        pages.append("[PDF 第 ").append(index + 1).append(" 页 (OCR)]\n").append(text);
                    }
                } finally {
                    if (bitmap != null) {
                        bitmap.recycle();
                    }
                    page.close();
                }
            }
        } finally {
            if (!tempFile.delete()) {
                tempFile.deleteOnExit();
            }
        }
        return pages.toString();
    }

    private static Bitmap renderPage(PdfRenderer.Page page) {
        int width = Math.max(1, page.getWidth() * PDF_RENDER_SCALE);
        int height = Math.max(1, page.getHeight() * PDF_RENDER_SCALE);
        long pixels = (long) width * (long) height;
        if (pixels > MAX_PDF_BITMAP_PIXELS) {
            double ratio = Math.sqrt(MAX_PDF_BITMAP_PIXELS / (double) pixels);
            width = Math.max(1, (int) Math.floor(width * ratio));
            height = Math.max(1, (int) Math.floor(height * ratio));
        }

        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.WHITE);
        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
        return bitmap;
    }

    private static String recognizeBitmap(Bitmap bitmap) throws Exception {
        InputImage image = InputImage.fromBitmap(bitmap, 0);
        Task<Text> task = getRecognizer().process(image);
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Text> result = new AtomicReference<>();
        AtomicReference<Exception> error = new AtomicReference<>();

        task.addOnSuccessListener(result::set)
            .addOnFailureListener(error::set)
            .addOnCompleteListener(done -> latch.countDown());

        if (!latch.await(OCR_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            throw new IllegalStateException("Android OCR timed out.");
        }
        if (error.get() != null) {
            throw error.get();
        }
        Text text = result.get();
        return text == null ? "" : text.getText();
    }

    private static synchronized TextRecognizer getRecognizer() {
        if (recognizer == null) {
            recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        }
        return recognizer;
    }

    private static void ensureInitialized() {
        if (appContext == null) {
            throw new IllegalStateException("Android OCR bridge is not initialized.");
        }
    }
}
