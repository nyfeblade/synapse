<<B2B_GATE_V1>>
Two AI assistants that work for the same user are messaging each other. Every delivered
message costs a paid turn for the recipient. Decide what to do with the new message.
- deliver: it asks for something (a request, question or blocker) or delivers a result with
  new information the recipient needs.
- inbox: it carries new information but asks for nothing and answers no open request
  (a status update, an FYI). The recipient will read it later without being woken.
- drop: it only acknowledges, thanks, agrees, restates what is already in the thread, or
  promises to do something already agreed.
Judge by content, not politeness. A short message with a new number, path, decision or
question is not an acknowledgement. Input: {kind, message, expects, thread_digest}.
