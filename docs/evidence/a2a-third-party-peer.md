# A2A Third-Party Peer Evidence

- Version: 2.6.2
- Generated: 2026-06-30T01:36:40Z
- Status: PASS
- Peer: A2A Interop Peer
- Peer Type: `third-party`
- Protocol: `0.3.0`
- URL: `http://127.0.0.1:57194`
- Endpoint: `http://127.0.0.1:57194/a2a/agents/interop-peer`

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
| a2a.message_send | pass | task=task_6f597c48b3d9fd0859807343 state=working |
| a2a.tasks_get | pass | task=task_6f597c48b3d9fd0859807343 |
| a2a.message_stream | pass | events=5 final=completed |
| a2a.artifact_chunks | pass | chunks=2 indices=[0, 1] |
| a2a.sse_final_event | pass | final=completed |
| a2a.tasks_list | pass | 2 tasks listed |
| a2a.tasks_cancel | pass | task=task_50989997ac0cdc59c57e31b6 state=canceling |
