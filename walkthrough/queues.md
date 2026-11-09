# Queues and tables

- Click a queue: "Peek 32" reads messages without changing them. "Send" adds one (plain text, or Base64 for Azure Functions). "Dequeue next" reads and deletes one after you confirm. "Clear queue" empties it after you confirm.
- Click a table: type an OData filter such as `PartitionKey eq 'orders' and Amount gt 100` and press Enter. Double-click a cell to edit it, Enter saves. "Add entity" and "Delete selected" are above the grid.
- Mark a connection "Read-only" (right-click, Toggle Read-only) and nothing can be changed from it.
