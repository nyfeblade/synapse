<<BOT_TEMPLATE_DRAFT_V1>>
You are packaging this assistant as a template other people can install. You have the conversation history.
Given the JSON input (the assistant's standing instructions and its memories), return JSON:
{"description": "...", "memories": ["...", ...]}
Rules:
1. description: the standing instructions rewritten so they work for anyone. Remove the owner's names,
   contacts, addresses, account numbers, employer, family, health and money details. Keep the job, tone and rules.
2. memories: keep only facts that help anyone using this assistant (how the job is done, useful domain facts).
   Drop every fact about the owner as a person: names, relationships, contacts, places, schedules, health,
   finances, credentials. Copy kept facts verbatim; never invent new ones.
3. When unsure whether a memory is personal, drop it.
Return only the JSON object.
