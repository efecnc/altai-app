# Patch: add `is_error` to `TelemetryEvent::ToolResult` (upstream `isanagent`)

> **Status:** Implemented and upstreamed in **altaidevorg/isanagent#39**. ALTAI
> depends on upstream `altaidevorg/isanagent` (`branch = "main"`) — no fork pin.
> This doc is kept as the design record for the change.

**Target repo:** `altaidevorg/isanagent` (`main`).

**Why:** ALTAI renders tool calls in the chat, but a *failed* tool currently
shows as a success. The agent already knows the outcome —
`ToolExecutionFinished::Completed(Result<String, String>)` — but
`finalize_tool_output` flattens it to a plain `String` before building
`TelemetryEvent::ToolResult`, which has **no error field**. So the Ok/Err bit is
discarded inside the crate and can never reach ALTAI. The only honest fix is to
carry the flag on the telemetry event. (ALTAI must not string-sniff `"Error:"` —
tools that legitimately return error text would be mis-flagged.)

---

## Crate changes (`altaidevorg/isanagent`)

### 1. `src/bus.rs` — add the field to the `ToolResult` variant

```diff
     ToolResult {
         chat_id: String,
         #[serde(default)]
         channel: String,
         tool_name: String,
         result: String,
+        /// True when the tool returned `Err` (failed) rather than `Ok`.
+        #[serde(default)]
+        is_error: bool,
         #[serde(default)]
         tool_call_id: Option<String>,
         #[serde(default, skip_serializing_if = "Option::is_none")]
         background_job_id: Option<String>,
     },
```

`#[serde(default)]` keeps the wire format backward-compatible (older producers
omit it → deserializes to `false`).

### 2. `src/agent/mod.rs` — set `is_error` at BOTH construction sites (~L2632 and ~L2733)

Both sites share this shape:

```diff
-                        let tool_result_text = finalize_tool_output(tool_result);
+                        let is_error = tool_result.is_err();
+                        let tool_result_text = finalize_tool_output(tool_result);
                         ...
                         let tr = TelemetryEvent::ToolResult {
                             chat_id: inbound.chat_id.clone(),
                             channel: inbound.channel.clone(),
                             tool_name: /* .clone() at L2634, .to_string() at L2735 */,
                             result: tool_result_text.clone(),
+                            is_error,
                             tool_call_id: Some(tc.id.clone()),
                             background_job_id: crate::bus::get_background_job_id(&inbound.metadata),
                         };
```

`tool_result` is the `Result<String, String>` from `ToolExecutionFinished::Completed`,
so `.is_err()` must be read **before** it is moved into `finalize_tool_output`.

### 3. Update the two exhaustive PATTERN sites (they have no `..`)

`src/logging.rs:343` and `src/main.rs:1102` destructure `ToolResult` listing
every field, so the new field must be added to the pattern or they won't compile.
Cleanest (no unused-variable warning):

```diff
         TelemetryEvent::ToolResult {
             chat_id,
             channel,
             tool_name,
             result,
+            is_error: _,
             tool_call_id,
             background_job_id,
         } => ...
```

(Apply to both files. Equivalently, add a trailing `..`.)

Then cut a new tag (e.g. `altai-v0.1.1`).

---

## ALTAI follow-up (after the new tag is published)

1. Bump the dep in `src-tauri/Cargo.toml`:
   `isanagent = { git = "...", tag = "altai-v0.1.1" }` and `cargo update -p isanagent`.

2. Consume the flag in `src-tauri/src/altai/agent/tauri_channel.rs`
   (`map_telemetry_to_event`):

```diff
         TelemetryEvent::ToolResult {
             tool_name,
             tool_call_id,
             result,
+            is_error,
             ..
         } => Some(Event::ToolCallEnd {
             id: tool_call_id.clone().unwrap_or_else(|| tool_name.clone()),
-            output: serde_json::Value::String(result.clone()),
-            error: None,
+            output: serde_json::Value::String(result.clone()),
+            error: if *is_error { Some(result.clone()) } else { None },
         }),
```

`Event::ToolCallEnd.error` already exists and the frontend bridge
(`endNativeToolCall`) already renders `output-error` state when `error` is set —
so no further frontend change is needed.
