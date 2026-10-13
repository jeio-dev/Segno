# A Project is renamed through `projects.rename`

The app's Project settings let the developer change a Project's name (gui.md § Settings), but the Engine host protocol had no call that changes it, and only app-level calls may change the Project registry. `projects.rename(id, name)` sets the registry's `name` to the trimmed value, writes no Event, and refuses a blank name with `bad-request`. Names need not be unique, because Projects are addressed by id and the sidebar can show two Projects with the same name.

## Considered Options

- **Drop the name setting, so a Project keeps its folder name.** That leaves two clones of the same repo, or repos with unhelpful folder names, indistinguishable in the sidebar.
