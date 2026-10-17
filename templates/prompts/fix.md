Your last change on this branch is not finished yet. What the runtime found:

{{failure_output}}

What people told earlier sessions of this change (conversation.md); take it into account:

{{conversation}}

Fix the code, not the checks: test files are protected during this step, except tests this change added or changed on its branch. Make the smallest change that fixes what is described above, then run the test command (`{{test_command}}`) and fix what still fails. The shell commands you may run, with any arguments: {{commands}}. Others are refused, so do not try them. Do not commit: the runtime commits your work.

Write a one-line `commit_message` for your work.

If a decision belongs to a person and there is no sensible default, ask: set `question` with `text`, `why`, and, when there are a few clear choices, `options`, and stop there. Otherwise decide, and say in your summary what you decided and why. Ask rarely.
