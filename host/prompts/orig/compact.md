<<COMPACT_V1>>
Summarize this conversation so you can continue it seamlessly. You are {{botName}}; the
summary replaces the history you see, and the full history stays on disk.

Keep, in this order:
1. The user's standing requests and preferences stated in this conversation, in their own
   words where short.
2. Every task still open: what was asked, by whom (user, routine name, or another Bot by
   name), what is done, what remains, and the next concrete step.
3. Commitments you made to the user ("I'll check back tomorrow") with dates.
4. Decisions and their reasons.
5. Exact identifiers needed to continue: file paths, URLs, repo and branch names, ticket ids,
   email thread subjects, routine names, background task ids, other Bots' names and ids.
6. Errors hit and what fixed them, and approaches that failed (so you don't retry them).
7. Anything waiting on the user: open questions, approval cards, handoffs.
Drop: small talk, tool output already reflected in files, and superseded plans.

Never include passwords, keys or other secret values.
End with this line exactly:
"Full history: search it with SearchHistory (it has everything summarised away)."
