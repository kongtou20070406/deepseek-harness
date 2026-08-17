# @deepseek-ai/dsh-client-ui-research-context

English | [中文](README.zh.md)

Browser renderer for Pi-Idea context assembly details inside DSH's existing ContextMeter. It intentionally registers no always-visible composer strip and no sidebar detective-board launcher. Users inspect or edit the current Session Idea with `/idea`.

The package keeps the dormant board and console components source-compatible for future command-opened surfaces, but they do not occupy the live layout.

## Model Experience

### On-demand context details

#### What the model sees

Nothing. The component reads Session projections and emits no model message.

#### Token effect

Zero model tokens.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- ContextMeter shows the bounded recent manifest projection; the append-only Session log owns the complete timeline.
- The visual detective board currently has no registered launcher; its semantic data remains preserved.
