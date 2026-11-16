## New

- A terminal command's approval card says which interpreter the command hands its text to, when that is not the terminal's own shell: **Runs through:** `bash -c`, `bash -lc in WSL`, `bash -c, then pwsh -c`, the login shell on a host reached by `ssh`, or a script, with a note when what runs is not all written in the command. An ordinary command, and one that already says it (`npm test`, `make`, `bash deploy.sh`), gets no line.
