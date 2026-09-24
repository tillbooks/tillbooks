-- The TILL.app launcher (M00, US-M00.2). `build-macos.sh` compiles it with `osacompile -s` into a
-- STAY-OPEN AppleScript applet: double-click starts `till up`, opens the Studio in the browser, and
-- Dock > Quit or Cmd+Q stops the server again.
--
-- Why an applet and not a shell script: a bundle whose executable is a bash script has no Apple
-- event loop, so the Dock's Quit never reaches it and the only way out is Force Quit, which orphans
-- `till up` on its port. An applet handles `quit`; stay-open keeps it alive to do so.
--
-- The trap this avoids: `do shell script` returns only when every process holding its stdout and
-- stderr has closed them. Backgrounding an AND-list (`cd x && nohup till up >> log 2>&1 &`) forks a
-- subshell that keeps both pipes open, so the call never returns and the applet hangs in `on run`
-- (the owner's hand-made dock applet did exactly this, 24.09.2026). Only the server command itself
-- is backgrounded here, with every descriptor redirected, so `echo $!` comes back at once.
property studioPort : "8788"
property serverPID : ""

on run
	set serverPID to ""
	set studioURL to "http://127.0.0.1:" & studioPort
	set listener to do shell script "/usr/sbin/lsof -nP -tiTCP:" & studioPort & " -sTCP:LISTEN 2>/dev/null | /usr/bin/head -1; exit 0"
	if listener is not "" then
		-- A Studio is already up (an earlier launch): adopt it if it is `till up`, so Quit still stops it.
		set cmd to do shell script "/bin/ps -o command= -p " & listener & "; exit 0"
		if cmd contains " up" and cmd contains "till" then set serverPID to listener
	else
		set logFile to "\"$HOME/Library/Logs/TILL.log\""
		set appDir to POSIX path of (path to me) & "Contents/Resources/app"
		set bundled to (do shell script "test -f " & quoted form of (appDir & "/bin/till.mjs") & " && echo yes || echo no") is "yes"
		-- A login shell so a Finder launch sees the user's PATH (node, till); `exec` keeps the PID the
		-- server's own, which is the PID Quit signals.
		if bundled then
			set serverCmd to "exec node " & quoted form of (appDir & "/bin/till.mjs") & " up --no-open"
		else
			set serverCmd to "exec till up --no-open"
		end if
		set serverPID to do shell script "mkdir -p \"$HOME/Library/Logs\"; nohup /bin/zsh -lc " & quoted form of serverCmd & " >> " & logFile & " 2>&1 < /dev/null & echo $!"
		do shell script "for i in $(/usr/bin/seq 1 40); do /usr/bin/curl -s -o /dev/null " & studioURL & " && exit 0; /bin/sleep 0.5; done; exit 0"
	end if
	open location studioURL
end run

on reopen
	-- Clicking the Dock icon again brings the Studio back into the browser.
	open location "http://127.0.0.1:" & studioPort
end reopen

on idle
	-- The server died on its own (a crash, killed in a terminal): the launcher has nothing left to do.
	if serverPID is not "" then
		try
			do shell script "/bin/kill -0 " & serverPID
		on error
			set serverPID to ""
			quit
		end try
	end if
	return 10
end idle

on quit
	if serverPID is not "" then
		try
			-- TERM first (till up closes its connections and the database), KILL after 2 seconds. A KILL
			-- is safe: SQLite's WAL keeps every committed write, and `till up` reclaims a stale lock.
			do shell script "p=" & serverPID & "; /bin/kill -TERM $p 2>/dev/null; for i in 1 2 3 4 5 6 7 8; do /bin/kill -0 $p 2>/dev/null || exit 0; /bin/sleep 0.25; done; /bin/kill -KILL $p 2>/dev/null; exit 0"
		end try
		set serverPID to ""
	end if
	continue quit
end quit
