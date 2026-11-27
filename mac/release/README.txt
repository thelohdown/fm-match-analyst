FM Tinkerman (alpha)
====================

An AI match analyst for Football Manager 27: pause a match and ask Claude what
is going on and what to change. It reads the match as it is played; it never
changes anything in the game.

You need
--------
- A Mac with Apple Silicon (M1 or later) on the latest macOS
- Football Manager 27 on Steam
- Claude Desktop (https://claude.ai/download)

Install (about 5 minutes, plus a few on FM's first launch)
-------
1. Quit FM27.
2. Download "FM27 BepInEx 6 IL2CPP for macOS (Apple Silicon)" from
   sortitoutsi.net into your Downloads folder. (Skip if you already use it.)
3. Double-click "Install FM Tinkerman.command".
   If macOS says it cannot be opened: System Settings > Privacy & Security,
   scroll down, click "Open Anyway". Or open Terminal, drag the file into it
   and press Return.
4. Paste the launch option it copied for you into Steam:
   right-click Football Manager 27 > Properties > General > Launch Options.
5. Click Install when Claude Desktop shows FM Tinkerman.
6. Launch FM27 from Steam. The first launch takes a few minutes.

First match
-----------
Start a match, pause it, and ask Claude:
- "How is my match going?"
- "How are they playing?"
- After a tactical change and 10 minutes: "Did that work?"
- After a goal: "Why did that happen?"
- Around 65': "Who should I take off?"
- At full time: "Build my post-match report."

Prefer hints over full answers? Say "just hints" in the chat, or set Level of
help in Claude Desktop > Settings > Extensions > FM Tinkerman.

Telling us how it went
----------------------
When an answer is right or wrong, tell Claude ("that was useful", "that's
wrong, they were pressing high"): it saves your verdict to
Documents/FM Tinkerman/feedback.jsonl. Send that file with your notes.

Updating
--------
- New FM Tinkerman version: double-click the new installer.
- FM update and the game will not start: download the new BepInEx package
  from sortitoutsi (usually out within a day) and double-click the installer
  again. It keeps your saved matches.

Uninstall
---------
In Terminal: "<path to>/Install FM Tinkerman.command" --uninstall
Then clear FM27's Launch Options in Steam, and remove the extension in
Claude Desktop > Settings > Extensions.
