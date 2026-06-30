/** Skill Workbench UI — v2.6.2 frontend integration. */

const SKILL_API = "/api/skills";
const PROJECT_API = "/api/workspace/projects";

let apiFetch = globalApiFetch;
let showToast = defaultShowToast;
let beforeOpenPanel = () => {};
let onPanelStateChange = () => {};
let onProjectOpen = () => {};
let getActiveProjectId = () => "";

function globalApiFetch(url, options = {}) {
  return fetch(url, { ...options, headers: options.headers || {} });
}

function defaultShowToast(message) {
  if (typeof window !== "undefined") window.alert(message);
}

const state = {
  skills: [],
  projects: [],
  activeProjectId: "",
  search: "",
  runningSkillId: "",
  recentRuns: [],
};

const els = {};

export function initSkillWorkbench(options = {}) {
  apiFetch = options.apiFetch || globalApiFetch;
  showToast = options.showToast || defaultShowToast;
  beforeOpenPanel = typeof options.beforeOpenPanel === "function" ? options.beforeOpenPanel : beforeOpenPanel;
  onPanelStateChange = typeof options.onPanelStateChange === "function" ? options.onPanelStateChange : onPanelStateChange;
  onProjectOpen = typeof options.onProjectOpen === "function" ? options.onProjectOpen : onProjectOpen;
  getActiveProjectId = typeof options.getActiveProjectId === "function" ? options.getActiveProjectId : getActiveProjectId;
  cacheElements();
  if (!els.skillPanel) return;
  bindEvents();
  loadSkills();
  loadProjects();
}

export function renderProjectSkillBinding(projectId, container) {
  if (!container) return;
  container.replaceChildren();
  if (!projectId) return;
  ensureSkillsLoaded()
    .then(() => fetchProjectSkills(projectId))
    .then((binding) => renderProjectSkillBindingForm(projectId, binding, container))
    .catch((error) => {
      container.textContent = `读取 Skill 绑定失败：${error.message || error}`;
    });
}

function cacheElements() {
  const ids = [
    "skillPanel",
    "closeSkillPanelButton",
    "skillButton",
    "skillSearchInput",
    "skillImportButton",
    "skillExportAllButton",
    "skillImportInput",
    "skillBuiltinList",
    "skillCustomList",
    "skillRecentRunList",
    "skillRunHost",
    "skillRunForm",
    "skillRunTitle",
    "skillRunFields",
    "skillRunProjectSelect",
    "skillRunModeSelect",
    "skillRunCancelButton",
    "skillRunSubmitButton",
    "skillRunResult",
    "skillRunResultBody",
    "skillRunResultActions",
    "skillRunSavedItemsLink",
    "skillRunArtifactsLink",
    "projectSkills",
    "projectSkillsBody",
  ];
  for (const id of ids) {
    els[id] = document.querySelector(`#${id}`);
  }
}

function bindEvents() {
  els.closeSkillPanelButton?.addEventListener("click", closeSkillPanel);
  els.skillButton?.addEventListener("click", openSkillPanel);
  els.skillSearchInput?.addEventListener("input", () => {
    state.search = (els.skillSearchInput.value || "").trim().toLowerCase();
    renderSkillPanel();
  });
  els.skillImportButton?.addEventListener("click", () => {
    if (els.skillImportInput) {
      els.skillImportInput.value = "";
      els.skillImportInput.click();
    }
  });
  els.skillImportInput?.addEventListener("change", importSkillFromFile);
  els.skillExportAllButton?.addEventListener("click", exportAllCustomSkills);
  els.skillBuiltinList?.addEventListener("click", onSkillListClick);
  els.skillCustomList?.addEventListener("click", onSkillListClick);
  els.skillRunCancelButton?.addEventListener("click", closeSkillRunHost);
  els.skillRunForm?.addEventListener("submit", onSkillRunSubmit);
  els.skillRunProjectSelect?.addEventListener("change", () => {
    state.activeProjectId = els.skillRunProjectSelect.value || "";
  });
  els.skillRunSavedItemsLink?.addEventListener("click", (event) => {
    event.preventDefault();
    openProjectPath("saved-items", state.activeProjectId);
  });
  els.skillRunArtifactsLink?.addEventListener("click", (event) => {
    event.preventDefault();
    openProjectPath("artifacts", state.activeProjectId);
  });
}

function openSkillPanel() {
  if (!els.skillPanel) return;
  beforeOpenPanel();
  closeSkillRunHost();
  loadSkills();
  loadProjects();
  els.skillPanel.classList.add("open");
  els.skillPanel.setAttribute("aria-hidden", "false");
  onPanelStateChange();
}

function closeSkillPanel() {
  if (!els.skillPanel) return;
  els.skillPanel.classList.remove("open");
  els.skillPanel.setAttribute("aria-hidden", "true");
  onPanelStateChange();
}

function openSkillRunHost(skill) {
  if (!els.skillRunHost || !skill) return;
  els.skillRunHost.hidden = false;
  els.skillRunTitle.textContent = `运行 · ${skill.name || skill.skillId}`;
  els.skillRunTitle.dataset.skillId = skill.skillId;
  renderRunFields(skill.inputSchema || {});
  populateProjectSelect();
  if (els.skillRunResult) els.skillRunResult.hidden = true;
}

function closeSkillRunHost() {
  if (els.skillRunHost) els.skillRunHost.hidden = true;
  if (els.skillRunResult) els.skillRunResult.hidden = true;
  state.runningSkillId = "";
}

function populateProjectSelect() {
  if (!els.skillRunProjectSelect) return;
  state.activeProjectId = getActiveProjectId() || state.activeProjectId || "";
  els.skillRunProjectSelect.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "不绑定项目";
  els.skillRunProjectSelect.append(none);
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    if (project.id === state.activeProjectId) option.selected = true;
    els.skillRunProjectSelect.append(option);
  }
}

function renderRunFields(schema) {
  if (!els.skillRunFields) return;
  els.skillRunFields.replaceChildren();
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  for (const [key, prop] of Object.entries(properties)) {
    const label = document.createElement("label");
    label.className = "skill-field";
    const span = document.createElement("span");
    span.textContent = `${prop.title || key}${required.has(key) ? " *" : ""}`;
    let input;
    if (prop.enum && Array.isArray(prop.enum)) {
      input = document.createElement("select");
      for (const choice of prop.enum) {
        const option = document.createElement("option");
        option.value = String(choice);
        option.textContent = String(choice);
        input.append(option);
      }
    } else if ((prop.type === "string" || prop.type === "text") && (prop.maxLength || 0) > 120) {
      input = document.createElement("textarea");
      input.rows = Math.min(8, Math.max(3, Math.ceil((prop.maxLength || 500) / 80)));
    } else {
      input = document.createElement("input");
      input.type = prop.type === "number" || prop.type === "integer" ? "number" : "text";
    }
    input.dataset.runField = key;
    input.dataset.runType = prop.type || "string";
    if (prop.description) input.placeholder = prop.description;
    if (required.has(key)) input.required = true;
    label.append(span, input);
    els.skillRunFields.append(label);
  }
  if (!Object.keys(properties).length) {
    const note = document.createElement("p");
    note.className = "panel-empty";
    note.textContent = "该 Skill 不需要输入参数。";
    els.skillRunFields.append(note);
  }
}

function collectRunInput() {
  const input = {};
  for (const field of els.skillRunFields?.querySelectorAll("[data-run-field]") || []) {
    const key = field.dataset.runField;
    const type = field.dataset.runType;
    let value = field.value;
    if (type === "number" || type === "integer") value = value === "" ? null : Number(value);
    if (value !== null && value !== "") input[key] = value;
  }
  return input;
}

async function onSkillRunSubmit(event) {
  event.preventDefault();
  const skillId = els.skillRunTitle?.dataset.skillId;
  if (!skillId || !els.skillRunSubmitButton) return;
  const input = collectRunInput();
  const projectId = els.skillRunProjectSelect?.value || "";
  const offline = els.skillRunModeSelect?.value === "offline";
  els.skillRunSubmitButton.disabled = true;
  els.skillRunSubmitButton.textContent = "运行中…";
  try {
    const payload = {
      action: "run",
      skillId,
      input,
      projectId,
      offline,
      persist: true,
    };
    const response = await apiFetch(SKILL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(response);
    if (!data.ok) throw new Error(data.error || "运行失败");
    state.runningSkillId = skillId;
    renderRunResult(data, projectId);
    if (projectId) loadRecentRuns(projectId);
  } catch (error) {
    showToast(`Skill 运行失败：${error.message || error}`);
  } finally {
    els.skillRunSubmitButton.disabled = false;
    els.skillRunSubmitButton.textContent = "运行";
  }
}

function renderRunResult(result, projectId) {
  if (!els.skillRunResult || !els.skillRunResultBody) return;
  els.skillRunResult.hidden = false;
  els.skillRunResultBody.replaceChildren();
  const output = result.output || {};
  const content = String(output.content || output.text || JSON.stringify(output, null, 2));
  const pre = document.createElement("pre");
  pre.className = "skill-run-content";
  pre.textContent = content.slice(0, 4000);
  els.skillRunResultBody.append(pre);

  const meta = document.createElement("p");
  meta.className = "skill-run-meta-text";
  meta.textContent = `runId: ${result.skillRunId || ""}${projectId ? ` · project: ${projectId}` : ""}`;
  els.skillRunResultBody.append(meta);

  const linked = [];
  for (const item of result.savedItems || []) {
    linked.push(`Saved Item: ${item.title || item.id || item.savedItemId || "saved item"}`);
  }
  for (const artifact of result.artifacts || []) {
    linked.push(`Artifact: ${artifact.name || artifact.title || artifact.id || artifact.artifactId || "artifact"}`);
  }
  if (linked.length) {
    const list = document.createElement("ul");
    list.className = "skill-run-linked-list";
    for (const text of linked) {
      const row = document.createElement("li");
      row.textContent = text;
      list.append(row);
    }
    els.skillRunResultBody.append(list);
  }

  if (els.skillRunResultActions) {
    const hasLinks = Boolean(projectId) && ((result.savedItems?.length) || (result.artifacts?.length));
    els.skillRunResultActions.hidden = !hasLinks;
  }
}

async function loadSkills() {
  try {
    const response = await apiFetch(SKILL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    const data = await parseJsonResponse(response);
    state.skills = Array.isArray(data.skills) ? data.skills : [];
    renderSkillPanel();
  } catch (error) {
    showToast(`读取 Skill 列表失败：${error.message || error}`);
  }
}

async function ensureSkillsLoaded() {
  if (state.skills.length) return;
  await loadSkills();
}

async function loadProjects() {
  try {
    const response = await apiFetch(`${PROJECT_API}`, { method: "GET" });
    const data = await parseJsonResponse(response);
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    populateProjectSelect();
  } catch {
    state.projects = [];
  }
}

async function loadRecentRuns(projectId) {
  if (!projectId) {
    state.recentRuns = [];
    renderRecentRuns();
    return;
  }
  try {
    const response = await apiFetch(`${PROJECT_API}/${projectId}/skill-runs?limit=20`, { method: "GET" });
    const data = await parseJsonResponse(response);
    state.recentRuns = Array.isArray(data.skillRuns) ? data.skillRuns : [];
    renderRecentRuns();
  } catch {
    state.recentRuns = [];
    renderRecentRuns();
  }
}

function renderSkillPanel() {
  if (!els.skillBuiltinList || !els.skillCustomList) return;
  const query = state.search;
  const matches = (skill) =>
    !query || [skill.name, skill.description, skill.skillId].join(" ").toLowerCase().includes(query);
  renderSkillCards(els.skillBuiltinList, state.skills.filter((skill) => skill.builtin && matches(skill)), "没有匹配的内置 Skill。");
  renderSkillCards(els.skillCustomList, state.skills.filter((skill) => !skill.builtin && matches(skill)), "还没有自定义 Skill，可从内置 Skill 导出后导入。");
  renderRecentRuns();
}

function renderSkillCards(host, skills, emptyText) {
  host.replaceChildren();
  if (!skills.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = emptyText;
    host.append(empty);
    return;
  }
  for (const skill of skills) {
    host.append(renderSkillCard(skill));
  }
}

function renderSkillCard(skill) {
  const card = document.createElement("article");
  card.className = "skill-card";
  card.classList.toggle("disabled", Boolean(skill.disabled));
  card.dataset.skillId = skill.skillId;

  const body = document.createElement("div");
  body.className = "skill-card-body";

  const title = document.createElement("h4");
  title.textContent = skill.name || skill.skillId;
  const description = document.createElement("p");
  description.textContent = skill.description || "";
  body.append(title, description);

  const tags = document.createElement("div");
  tags.className = "skill-card-tags";
  const builtinTag = document.createElement("span");
  builtinTag.className = "skill-tag";
  builtinTag.textContent = skill.builtin ? "内置" : "自定义";
  tags.append(builtinTag);
  const toolsTag = document.createElement("span");
  toolsTag.className = "skill-tag";
  toolsTag.textContent = `${(skill.allowedTools || []).length} 个工具`;
  tags.append(toolsTag);
  body.append(tags);

  const actions = document.createElement("div");
  actions.className = "skill-card-actions";

  const run = document.createElement("button");
  run.type = "button";
  run.className = "seek-primary-button";
  run.dataset.skillRun = skill.skillId;
  run.textContent = "运行";
  actions.append(run);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "secondary-button";
  toggle.dataset.skillToggle = skill.skillId;
  toggle.textContent = skill.disabled ? "启用" : "禁用";
  actions.append(toggle);

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "secondary-button";
  exportButton.dataset.skillExport = skill.skillId;
  exportButton.textContent = "导出";
  actions.append(exportButton);

  if (!skill.builtin) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary-button";
    edit.dataset.skillEdit = skill.skillId;
    edit.textContent = "编辑";
    actions.append(edit);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.dataset.skillDelete = skill.skillId;
    remove.textContent = "删除";
    actions.append(remove);
  }

  card.append(body, actions);
  return card;
}

function onSkillListClick(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const runButton = target?.closest("button[data-skill-run]");
  if (runButton) {
    const skill = state.skills.find((item) => item.skillId === runButton.dataset.skillRun);
    if (skill) openSkillRunHost(skill);
    return;
  }
  const toggleButton = target?.closest("button[data-skill-toggle]");
  if (toggleButton) {
    toggleSkill(toggleButton.dataset.skillToggle);
    return;
  }
  const exportButton = target?.closest("button[data-skill-export]");
  if (exportButton) {
    exportSkill(exportButton.dataset.skillExport);
    return;
  }
  const editButton = target?.closest("button[data-skill-edit]");
  if (editButton) {
    editSkill(editButton.dataset.skillEdit);
    return;
  }
  const deleteButton = target?.closest("button[data-skill-delete]");
  if (deleteButton) {
    deleteSkill(deleteButton.dataset.skillDelete);
  }
}

async function toggleSkill(skillId) {
  const skill = state.skills.find((item) => item.skillId === skillId);
  if (!skill) return;
  const action = skill.disabled ? "enable" : "disable";
  try {
    const response = await apiFetch(SKILL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, skillId }),
    });
    await parseJsonResponse(response);
    await loadSkills();
    showToast(`${skill.name || skillId} 已${action === "enable" ? "启用" : "禁用"}`);
  } catch (error) {
    showToast(`切换 Skill 状态失败：${error.message || error}`);
  }
}

async function exportSkill(skillId) {
  try {
    const response = await apiFetch(SKILL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "export", skillId }),
    });
    const data = await parseJsonResponse(response);
    if (!data.ok) throw new Error(data.error || "导出失败");
    const text = `${JSON.stringify(data.skill || {}, null, 2)}\n`;
    downloadTextFile(text, `skill-${skillId}.json`, "application/json;charset=utf-8");
  } catch (error) {
    showToast(`导出 Skill 失败：${error.message || error}`);
  }
}

async function exportAllCustomSkills() {
  const custom = state.skills.filter((item) => !item.builtin);
  if (!custom.length) {
    showToast("没有可导出的自定义 Skill");
    return;
  }
  try {
    const exported = [];
    for (const skill of custom) {
      const response = await apiFetch(SKILL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", skillId: skill.skillId }),
      });
      const data = await parseJsonResponse(response);
      if (data.ok && data.skill) exported.push(data.skill);
    }
    const text = `${JSON.stringify({ exportedAt: new Date().toISOString(), skills: exported }, null, 2)}\n`;
    downloadTextFile(text, `deepseek-skills-${new Date().toISOString().slice(0, 10)}.json`, "application/json;charset=utf-8");
    showToast(`已导出 ${exported.length} 个自定义 Skill`);
  } catch (error) {
    showToast(`导出失败：${error.message || error}`);
  }
}

async function importSkillFromFile(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const skills = Array.isArray(payload.skills) ? payload.skills : [payload];
    let imported = 0;
    for (const skill of skills) {
      if (!skill.skillId) continue;
      const response = await apiFetch(SKILL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import", skill, overwrite: true }),
      });
      const data = await parseJsonResponse(response);
      if (data.ok) imported += 1;
    }
    showToast(`已导入 ${imported} 个 Skill`);
    await loadSkills();
  } catch (error) {
    showToast(`导入失败：${error.message || error}`);
  } finally {
    if (els.skillImportInput) els.skillImportInput.value = "";
  }
}

function editSkill(skillId) {
  const skill = state.skills.find((item) => item.skillId === skillId);
  if (!skill) return;
  const updatedName = window.prompt("Skill 名称", skill.name || "");
  if (updatedName === null) return;
  const updatedDescription = window.prompt("Skill 简介", skill.description || "");
  if (updatedDescription === null) return;
  const patch = { name: updatedName, description: updatedDescription };
  apiFetch(SKILL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", skillId, patch }),
  })
    .then(parseJsonResponse)
    .then(() => loadSkills())
    .catch((error) => showToast(`更新失败：${error.message || error}`));
}

async function deleteSkill(skillId) {
  const skill = state.skills.find((item) => item.skillId === skillId);
  if (!skill) return;
  if (!window.confirm(`删除自定义 Skill「${skill.name || skillId}」？`)) return;
  try {
    const response = await apiFetch(SKILL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", skillId }),
    });
    await parseJsonResponse(response);
    await loadSkills();
  } catch (error) {
    showToast(`删除失败：${error.message || error}`);
  }
}

function renderRecentRuns() {
  if (!els.skillRecentRunList) return;
  els.skillRecentRunList.replaceChildren();
  if (!state.recentRuns.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "暂无最近运行。";
    els.skillRecentRunList.append(empty);
    return;
  }
  for (const run of state.recentRuns) {
    const row = document.createElement("article");
    row.className = "skill-run-row";
    row.innerHTML = `<div><strong></strong><span></span></div><time></time>`;
    row.querySelector("strong").textContent = run.skillId || "skill";
    row.querySelector("span").textContent = run.status || "completed";
    row.querySelector("time").textContent = run.completedAt ? new Date(run.completedAt).toLocaleString() : "";
    els.skillRecentRunList.append(row);
  }
}

async function fetchProjectSkills(projectId) {
  const response = await apiFetch(`${PROJECT_API}/${projectId}/skills`, { method: "GET" });
  const data = await parseJsonResponse(response);
  return data.skills || { enabledSkills: [], defaultSkill: "", recentSkills: [] };
}

function renderProjectSkillBindingForm(projectId, binding, container) {
  container.replaceChildren();
  const allSkills = state.skills.length ? state.skills : [];
  const enabled = new Set(binding.enabledSkills || []);

  const enabledLabel = document.createElement("label");
  enabledLabel.className = "project-skill-field";
  enabledLabel.innerHTML = "<span>启用 Skills</span>";
  const enabledSelect = document.createElement("select");
  enabledSelect.multiple = true;
  enabledSelect.dataset.projectSkillBinding = "enabled";
  for (const skill of allSkills) {
    const option = document.createElement("option");
    option.value = skill.skillId;
    option.textContent = skill.name || skill.skillId;
    option.selected = enabled.has(skill.skillId);
    enabledSelect.append(option);
  }
  enabledLabel.append(enabledSelect);
  container.append(enabledLabel);

  const defaultLabel = document.createElement("label");
  defaultLabel.className = "project-skill-field";
  defaultLabel.innerHTML = "<span>默认 Skill</span>";
  const defaultSelect = document.createElement("select");
  defaultSelect.dataset.projectSkillBinding = "default";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "无";
  defaultSelect.append(none);
  for (const skillId of enabled) {
    const skill = allSkills.find((item) => item.skillId === skillId);
    const option = document.createElement("option");
    option.value = skillId;
    option.textContent = skill ? skill.name || skillId : skillId;
    option.selected = skillId === binding.defaultSkill;
    defaultSelect.append(option);
  }
  defaultLabel.append(defaultSelect);
  container.append(defaultLabel);

  enabledSelect.addEventListener("change", () => {
    const selected = Array.from(enabledSelect.selectedOptions).map((option) => option.value);
    defaultSelect.replaceChildren();
    const none2 = document.createElement("option");
    none2.value = "";
    none2.textContent = "无";
    defaultSelect.append(none2);
    for (const skillId of selected) {
      const skill = allSkills.find((item) => item.skillId === skillId);
      const option = document.createElement("option");
      option.value = skillId;
      option.textContent = skill ? skill.name || skillId : skillId;
      defaultSelect.append(option);
    }
    if (!selected.includes(defaultSelect.value)) defaultSelect.value = "";
    saveProjectSkillBinding(projectId);
  });

  defaultSelect.addEventListener("change", () => saveProjectSkillBinding(projectId));

  if (binding.recentSkills?.length) {
    const recent = document.createElement("p");
    recent.className = "project-skill-recent";
    recent.textContent = `最近使用：${binding.recentSkills.join("、")}`;
    container.append(recent);
  }
}

async function saveProjectSkillBinding(projectId) {
  const container = els.projectSkillsBody;
  if (!container) return;
  const enabledSelect = container.querySelector('[data-project-skill-binding="enabled"]');
  const defaultSelect = container.querySelector('[data-project-skill-binding="default"]');
  const enabled = Array.from(enabledSelect?.selectedOptions || []).map((option) => option.value);
  const defaultSkill = defaultSelect?.value || "";
  try {
    await apiFetch(`${PROJECT_API}/${projectId}/skills`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabledSkills: enabled, defaultSkill }),
    });
  } catch (error) {
    showToast(`保存 Skill 绑定失败：${error.message || error}`);
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    data = { ok: false, error: text || "Invalid JSON" };
  }
  if (!response.ok) {
    throw new Error(data.error || data.detail || text || `HTTP ${response.status}`);
  }
  return data;
}

function downloadTextFile(text, filename, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openProjectPath(tab, projectId) {
  if (!projectId) return;
  onProjectOpen({ tab, projectId });
}

export function isSkillPanelOpen() {
  return Boolean(els.skillPanel?.classList.contains("open"));
}

export function closeSkillWorkbench() {
  closeSkillPanel();
}
