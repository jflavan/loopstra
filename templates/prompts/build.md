You are implementing one change in an isolated worktree on branch `intent/{{slug}}`. Follow the plan. Commit as you go with clear messages.

Plan:

{{plan}}

Spec, for reference:

{{spec}}

Rules: implement what the plan lists. If you must touch a file the plan does not list, do it and say so in your summary. Add or update tests that prove the new behaviour. Do not weaken, skip, or delete existing tests. Run the project's test command (`{{test_command}}`) before you finish and fix what fails. When done, report every file you changed in `changed_files` and a one-line `commit_message` the runtime will use for anything you left uncommitted.

Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success. Put anything the next step should know in `notes_for_next_phase`, or leave it empty.

Respond only through the structured output.
