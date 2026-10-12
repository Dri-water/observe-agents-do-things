# Changelog

## 0.2.1

- VS Code: skip observers older than the extension

## 0.2.0

- Make the shared rooms lived-in: team looks, decor, mess, a bigger lounge
- Add The Court visualizer; one shared room by default in Court and Office
- Document the manual VS Code Marketplace upload
- Check that the Marketplace matches the latest release; document manual uploads
- Lead the quick start with npx; normalize the CLI bin paths

## 0.1.1

- Release workflow: publish to npm with the latest npm
- Drop Open VSX: Cursor, Windsurf and VSCodium install the .vsix from the GitHub release
- Release workflow: npm through trusted publishing instead of a stored token
- Release workflow: manual dry run builds and packages without publishing
- Release workflow: one tag publishes the GitHub release, VS Code Marketplace, Open VSX and npm
- Office: 'need you' opens a list of who needs you, at any width; badges on room chips
- Fix false 'needs approval', rooms vanishing between turns, and the extension squatting on the CLI port
- README: install the VS Code extension from the v0.1.0 release

## 0.1.0

- First release: the Mission Control and Agent Office dashboards in an editor tab, a status bar item for agents that need you, and optional notifications.
- Uses an observer already running at `observeAgents.serverUrl`, or starts one inside VS Code that other windows share.
