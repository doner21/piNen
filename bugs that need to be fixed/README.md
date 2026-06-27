# Bug Notes

This directory tracks bugs observed in Pi, its tools, extensions, orchestration,
scheduler, and related components.

## How to Use

When you observe a bug, create a new markdown file using the
[BUG_NOTE_TEMPLATE.md](BUG_NOTE_TEMPLATE.md).

## Template

See [BUG_NOTE_TEMPLATE.md](BUG_NOTE_TEMPLATE.md) for the required format.

## Guidelines

- Include a clear title, date observed, and evidence
- Include the impact and suggested fix when known
- Mark as `Status: not fixed` for bugs that still need work
- Change to `Status: fixed` only when verified fixed
- Do not mark a bug fixed merely because a workaround exists

## Location

In a live piNen installation, this directory lives at:
- Windows: `%USERPROFILE%\.pi\bugs that need to be fixed\`
- Linux/macOS: `$HOME/.pi/bugs that need to be fixed/`

But note files are specific to your local Pi installation and are gitignored
by default.
