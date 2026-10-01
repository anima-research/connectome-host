Fleet preserves Unicode in child JSONL events when socket reads split a UTF-8
character across chunks. Reconnected sockets start a fresh line buffer and ignore
data callbacks from a superseded connection.
