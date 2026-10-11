# jobctl

`jobctl run NAME` starts the job NAME and streams its progress.

Output: progress lines on stdout (`progress 40%`). When the job completes, jobctl prints a JSON
line `{"event": "done", "job": "NAME"}` on stdout and exits with status 0.
