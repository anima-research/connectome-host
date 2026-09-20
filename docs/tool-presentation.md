# Tool-presentation configuration

Requires the companion agent-framework tool-presentation API. Land/release the framework change first, then update this host's minimum dependency to that release before merging the host change. Local development uses a linked framework build; no guessed release number is committed.

```json
{
  "agent": {
    "toolPresentation": {
      "path": "/absolute/path/to/tool-presentation.json",
      "cataloguePath": "board/tool-catalogue.md"
    }
  }
}
```

Merge this fragment into an existing recipe. Workspace must be enabled and contain the catalogue mount. Use a reserved catalogue filename; it is generated through `workspace--read`, not maintained on disk. The override file is an ordinary editable file with `{"version":1,"tools":{}}` for defaults. A missing file also means defaults; its parent directory must exist and be writable for editing tools.

Restart to enable/change the recipe setting. Wording/visibility edits in the JSON file are read on subsequent request compilation without restart. The debug context response includes `toolPresentation` metadata captured with that preview request. The existing WebUI has not gained a dedicated presentation editor.

For files edited through workspace tools, ensure materialization to disk is enabled. If both direct disk/tool-presentation edits and workspace text edits are used, synchronize the workspace copy before workspace read/edit: ordinary workspace text entries can remain cached in Chronicle. The generated catalogue itself always bypasses that cache. Using a configuration file outside workspace (and the two editing tools or a filesystem editor) avoids that ambiguity.

Remove the recipe field and restart to disable. Keep backups of the previous recipe and override file. This feature does not upgrade provider adapters or enable other behavioural modules.

## Component description defaults

Optional `toolPresentation.defaults` is an array of `{source, path}` profiles, with absolute file paths and unique registered source labels (for example `Module: workspace` or `MCPL server: discord`). Each profile uses `{version:1,tools:{"exact-tool-name":{description:"..."}}}`. Profiles may supply descriptions only; visibility stays in the resident file. Binding uses the tool registry's source attribution, not a guessed name prefix. A missing component contributes nothing, including no missing-profile error. Unknown tool entries never create tools.

Precedence: installed description → selected component profile → resident description. Setting a resident description to null removes that override and reveals the selected default. Existing configurations without profiles retain their behavior. Malformed active profiles produce diagnostics and fall back to installed wording; resident overrides still apply. Parameter descriptions are not overridden by these files. Snapshot entries expose descriptionSource, and the generated catalogue includes it.

Profiles are explicitly selected by deployment configuration in this prototype; packages are not automatically discovered. Shared wording can ultimately move upstream into each component. Local profiles let deployments try wording independently while preserving ordinary resident files.
