# A2A Third-Party Peer Evidence

- Version: 2.6.1
- Generated: 2026-06-29T12:02:38Z
- Status: PASS
- Peer: A2A Interop Peer
- Peer Type: `third-party`
- Protocol: `0.3.0`
- URL: `http://127.0.0.1:50708`
- Endpoint: `http://127.0.0.1:50708/a2a/agents/interop-peer`

| Check | Status |
| --- | --- |
| agentCard | PASS |
| messageSend | PASS |
| messageStream | PASS |
| tasksGet | PASS |
| tasksCancel | PASS |
| tasksList | PASS |
| artifactChunks | PASS |
| sseFinalEvent | PASS |

## Steps

| Step | Status | Detail |
| --- | --- | --- |
| a2a.agent_card | pass | name=A2A Interop Peer protocol=0.3.0 |
| a2a.message_send | pass | task=task_3235e8d1b7be83a980dff2b2 state=working |
| a2a.tasks_get | pass | task=task_3235e8d1b7be83a980dff2b2 |
| a2a.message_stream | pass | events=5 final=completed |
| a2a.artifact_chunks | pass | chunks=2 indices=[0, 1] |
| a2a.sse_final_event | pass | final=completed |
| a2a.tasks_list | pass | 2 tasks listed |
| a2a.tasks_cancel | pass | task=task_e93a93e7f89b231dd86591c1 state=canceling |
