pub mod commands;
// T21 defines and tests the persistence boundary; T22 wires it into runtime delivery/replay.
#[allow(dead_code)]
pub mod event_journal;
pub mod runtime;
pub mod tauri_channel;
