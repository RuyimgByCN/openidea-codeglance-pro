//! CodeGlance Pro for OpenIDEA: manages minimap configuration, quick-toggle
//! commands, `when` context state, and configuration syncing with the
//! `minimap` editor panel web page.

use openidea_plugin::host::{self, storage};
use openidea_plugin::views::{View, ViewEvent, Viewport, Views};
use openidea_plugin::{Context, Error, Event, EventKind, Invocation, Plugin, register_plugin};
use serde::Serialize;
use serde_json::Value;

pub const VIEW: &str = "minimap";
const OVERRIDE_HIDDEN: &str = "override:hidden";
const OVERRIDE_CLEAN_MODE: &str = "override:cleanMode";
const OVERRIDE_HOVER_LENS: &str = "override:showHoverLens";

/// Normalized plugin configuration sent to the editor panel web view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimapConfig {
    pub enabled: bool,
    pub pixels_per_line: u32,
    pub clean_mode: bool,
    pub render_mode: String,
    pub viewport_style: String,
    pub show_hover_lens: bool,
    pub hover_lens_lines: u32,
    pub show_vcs_changes: bool,
    pub show_problems: bool,
    pub show_selections: bool,
    pub show_region_comments: bool,
    pub auto_hide_short_files: u32,
    pub max_lines: u32,
}

impl Default for MinimapConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            pixels_per_line: 3,
            clean_mode: true,
            render_mode: "syntax".into(),
            viewport_style: "shaded".into(),
            show_hover_lens: true,
            hover_lens_lines: 9,
            show_vcs_changes: true,
            show_problems: true,
            show_selections: true,
            show_region_comments: true,
            auto_hide_short_files: 0,
            max_lines: 50_000,
        }
    }
}

fn storage_bool(key: &str) -> Option<bool> {
    match storage::get(key).ok().flatten().as_deref() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

fn setting_enum(key: &str, allowed: &[&str], default: &str) -> String {
    host::setting_string(key)
        .filter(|v| allowed.contains(&v.as_str()))
        .unwrap_or_else(|| default.to_owned())
}

fn setting_u32(key: &str, min: u32, max: u32, default: u32) -> u32 {
    let parsed = host::setting_number(key)
        .or_else(|| host::setting_string(key).and_then(|s| s.trim().parse::<f64>().ok()));
    match parsed {
        Some(v) if v.is_finite() => (v.round() as i64).clamp(i64::from(min), i64::from(max)) as u32,
        _ => default,
    }
}

impl MinimapConfig {
    /// Loads effective configuration by combining plugin settings and quick-toggle overrides.
    pub fn load() -> Self {
        let d = Self::default();
        let base_enabled = host::setting_bool("enabled").unwrap_or(d.enabled);
        let enabled = storage_bool(OVERRIDE_HIDDEN).map_or(base_enabled, |hidden| !hidden);
        let clean_mode = storage_bool(OVERRIDE_CLEAN_MODE)
            .unwrap_or_else(|| host::setting_bool("cleanMode").unwrap_or(d.clean_mode));
        let show_hover_lens = storage_bool(OVERRIDE_HOVER_LENS)
            .unwrap_or_else(|| host::setting_bool("showHoverLens").unwrap_or(d.show_hover_lens));
        Self {
            enabled,
            pixels_per_line: setting_u32("pixelsPerLine", 2, 4, d.pixels_per_line),
            clean_mode,
            render_mode: setting_enum(
                "renderMode",
                &["syntax", "monochrome", "accent"],
                &d.render_mode,
            ),
            viewport_style: setting_enum(
                "viewportStyle",
                &["shaded", "outline", "minimal"],
                &d.viewport_style,
            ),
            show_hover_lens,
            hover_lens_lines: setting_u32("hoverLensLines", 5, 21, d.hover_lens_lines),
            show_vcs_changes: host::setting_bool("showVcsChanges").unwrap_or(d.show_vcs_changes),
            show_problems: host::setting_bool("showProblems").unwrap_or(d.show_problems),
            show_selections: host::setting_bool("showSelections").unwrap_or(d.show_selections),
            show_region_comments: host::setting_bool("showRegionComments")
                .unwrap_or(d.show_region_comments),
            auto_hide_short_files: setting_u32(
                "autoHideShortFiles",
                0,
                10_000,
                d.auto_hide_short_files,
            ),
            max_lines: setting_u32("maxLines", 1_000, 500_000, d.max_lines),
        }
    }
}

fn sync_context_and_broadcast() -> MinimapConfig {
    let config = MinimapConfig::load();
    let _ = host::set_context("hidden", !config.enabled);
    if let Ok(payload) =
        serde_json::to_string(&serde_json::json!({ "op": "config", "config": config }))
    {
        let _ = host::post_view_message(VIEW, &payload);
    }
    config
}

fn toggle_override(storage_key: &str, current: bool, invert_stored: bool) -> Result<(), Error> {
    let next = !current;
    let stored = if invert_stored { !next } else { next };
    storage::set(storage_key, if stored { "true" } else { "false" })
}

fn clear_overrides_for_changed_keys(data: &str) {
    let keys: Vec<String> = serde_json::from_str(data).unwrap_or_default();
    let touches = |name: &str| {
        keys.is_empty()
            || keys
                .iter()
                .any(|k| k == name || k.ends_with(&format!(".{name}")))
    };
    if touches("enabled") {
        let _ = storage::delete(OVERRIDE_HIDDEN);
    }
    if touches("cleanMode") {
        let _ = storage::delete(OVERRIDE_CLEAN_MODE);
    }
    if touches("showHoverLens") {
        let _ = storage::delete(OVERRIDE_HOVER_LENS);
    }
}

#[derive(Default)]
pub struct CodeGlancePro;

impl CodeGlancePro {
    fn dispatch(&mut self, id: &str) -> Result<Option<String>, Error> {
        let current = MinimapConfig::load();
        match id {
            "toggle" => {
                toggle_override(OVERRIDE_HIDDEN, current.enabled, true)?;
                let updated = sync_context_and_broadcast();
                Ok(Some(if updated.enabled {
                    "CodeGlance Pro: Minimap enabled".into()
                } else {
                    "CodeGlance Pro: Minimap hidden".into()
                }))
            }
            "toggle-clean" => {
                toggle_override(OVERRIDE_CLEAN_MODE, current.clean_mode, false)?;
                let updated = sync_context_and_broadcast();
                Ok(Some(if updated.clean_mode {
                    "CodeGlance Pro: Clean Mode on".into()
                } else {
                    "CodeGlance Pro: Clean Mode off".into()
                }))
            }
            "toggle-hover-lens" => {
                toggle_override(OVERRIDE_HOVER_LENS, current.show_hover_lens, false)?;
                let updated = sync_context_and_broadcast();
                Ok(Some(if updated.show_hover_lens {
                    "CodeGlance Pro: Hover Code Lens on".into()
                } else {
                    "CodeGlance Pro: Hover Code Lens off".into()
                }))
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }
}

impl Plugin for CodeGlancePro {
    fn activate(&mut self, _ctx: &Context) -> Result<(), Error> {
        let _ = host::subscribe(EventKind::SettingsChanged);
        sync_context_and_broadcast();
        Ok(())
    }

    fn run_command(
        &mut self,
        id: &str,
        _ctx: &Invocation,
        _arg: Option<&str>,
    ) -> Result<Option<String>, Error> {
        self.dispatch(id)
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        for event in events {
            if let Event::Other { kind, data } = event
                && kind == "settings-changed"
            {
                clear_overrides_for_changed_keys(data);
                sync_context_and_broadcast();
            }
        }
    }
}

impl Views for CodeGlancePro {
    fn render(
        &mut self,
        view: &str,
        _viewport: Option<Viewport>,
        _ctx: &Invocation,
    ) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        Ok(View::message(
            "CodeGlance Pro minimap renders inside its editor panel page.",
        ))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        let ViewEvent::Message(raw) = event else {
            return Ok(());
        };
        let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
            return Ok(());
        };
        match payload.get("op").and_then(Value::as_str) {
            Some("ready") => {
                sync_context_and_broadcast();
                Ok(())
            }
            Some(op @ ("toggle" | "toggle-clean" | "toggle-hover-lens")) => {
                self.dispatch(op)?;
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

register_plugin!(CodeGlancePro, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    fn install_host() -> MockHost {
        MockHost::install().with_capabilities(&["editor.read", "storage", "events"])
    }

    #[test]
    fn loads_defaults_and_clamps_out_of_range_settings() {
        let host = install_host();
        assert_eq!(MinimapConfig::load(), MinimapConfig::default());

        host.set_setting("pixelsPerLine", "\"9\"");
        host.set_setting("hoverLensLines", "1");
        host.set_setting("renderMode", "\"invalid\"");
        host.set_setting("viewportStyle", "\"outline\"");
        host.set_setting("autoHideShortFiles", "999999");
        host.set_setting("maxLines", "50");

        let cfg = MinimapConfig::load();
        assert_eq!(cfg.pixels_per_line, 4);
        assert_eq!(cfg.hover_lens_lines, 5);
        assert_eq!(cfg.render_mode, "syntax");
        assert_eq!(cfg.viewport_style, "outline");
        assert_eq!(cfg.auto_hide_short_files, 10_000);
        assert_eq!(cfg.max_lines, 1_000);
    }

    #[test]
    fn toggle_commands_update_context_storage_and_view_messages() {
        let host = install_host();
        let mut plugin = CodeGlancePro;
        plugin
            .activate(&host.context("ruyimg.codeglance-pro"))
            .unwrap();
        assert_eq!(
            host.context_keys().get("hidden"),
            Some(&openidea_plugin::ContextValue::Flag(false))
        );

        let msg = plugin
            .run_command("toggle", &host.invocation(), None)
            .unwrap();
        assert_eq!(msg.as_deref(), Some("CodeGlance Pro: Minimap hidden"));
        assert_eq!(
            host.context_keys().get("hidden"),
            Some(&openidea_plugin::ContextValue::Flag(true))
        );

        let msg = plugin
            .run_command("toggle-clean", &host.invocation(), None)
            .unwrap();
        assert_eq!(msg.as_deref(), Some("CodeGlance Pro: Clean Mode off"));

        let msg = plugin
            .run_command("toggle-hover-lens", &host.invocation(), None)
            .unwrap();
        assert_eq!(msg.as_deref(), Some("CodeGlance Pro: Hover Code Lens off"));

        let messages = host.view_messages();
        let (_, last) = messages.last().unwrap();
        let v: Value = serde_json::from_str(last).unwrap();
        assert_eq!(v["op"], "config");
        assert_eq!(v["config"]["enabled"], false);
        assert_eq!(v["config"]["cleanMode"], false);
        assert_eq!(v["config"]["showHoverLens"], false);
    }

    #[test]
    fn settings_changed_clears_matching_override_and_ready_syncs_config() {
        let host = install_host();
        let mut plugin = CodeGlancePro;
        plugin
            .run_command("toggle", &host.invocation(), None)
            .unwrap();
        assert!(!MinimapConfig::load().enabled);

        host.set_setting("enabled", "true");
        plugin.handle_events(
            &[Event::Other {
                kind: "settings-changed".into(),
                data: r#"["ruyimg.codeglance-pro.enabled"]"#.into(),
            }],
            &host.invocation(),
        );
        assert!(MinimapConfig::load().enabled);
        assert_eq!(
            host.context_keys().get("hidden"),
            Some(&openidea_plugin::ContextValue::Flag(false))
        );

        let before = host.view_messages().len();
        plugin
            .handle(
                VIEW,
                ViewEvent::Message(r#"{"op":"ready"}"#.into()),
                &host.invocation(),
            )
            .unwrap();
        assert_eq!(host.view_messages().len(), before + 1);
    }
}
