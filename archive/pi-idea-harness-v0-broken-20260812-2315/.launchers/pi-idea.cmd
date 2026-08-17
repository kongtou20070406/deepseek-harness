@echo off
setlocal
set "PI_CLI=C:\Users\27363\Documents\ChatGPT\Idea\.tools\pi-cli\node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
"C:\Users\27363\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "C:\Users\27363\Documents\ChatGPT\Idea\pi-idea-harness\bin\pi-idea.js" %*
set "PI_IDEA_COMMAND_EXIT=%ERRORLEVEL%"
exit /b %PI_IDEA_COMMAND_EXIT%
