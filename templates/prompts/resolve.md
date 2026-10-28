This change's branch no longer applies cleanly to `{{main_branch}}`: other work merged into `{{main_branch}}` since it was built changed the same lines. The runtime has applied the whole change on top of `{{main_branch}}` in this workspace, and git left the conflicts in the files below. Your job is to resolve them.

This change's spec:

{{spec}}

This change's plan:

{{plan}}

The conflicts, with the commits on `{{main_branch}}` that touched these files:

{{conflicts}}

Each conflict shows three parts: between `<<<<<<<` and `|||||||` is `{{main_branch}}`'s version, between `|||||||` and `=======` is the version both started from, and between `=======` and `>>>>>>>` is this change's version. Read each conflicted file in full, and the other changes' specs where they are named, before you edit.

Keep what both sides meant: `{{main_branch}}`'s work must keep working, and this change must still do what its spec says. Edit only what resolving the conflicts needs, add no new files (new untracked files are removed before your work is saved), and leave no conflict marker lines in any file. A file deleted on one side and changed on the other: keep it or delete it, whichever keeps both changes working. You may run the test command (`{{test_command}}`) to check your work. The shell commands you may run, with any arguments: {{commands}}. Never run git commands that change the history or the index (commit, add, rebase, reset, checkout, merge, stash): the runtime saves your work.

If you cannot resolve a conflict safely (the two changes want opposite things, or you would have to guess what a person meant), stop, leave the files as they are, set `resolved` to false, and say why in `reason`. Otherwise set `resolved` to true and `reason` to an empty string.

Write `summary_markdown` for the reviewer who reads the change next: one short paragraph per file, saying what each side wanted and what you kept.
