#!/usr/bin/env python3
# Control helper for GT-SIP-GW .70 over SSH (root/BcastTerm2:9521). pty feeds password.
# modes: put <local> <remote> | sh <remote_cmd> | bg <remote_cmd>  (background, returns)
import pty, os, sys, select, time
HOST=os.environ.get("MZHOST","192.168.0.70"); PORT=9521; USER="root"; PW="BcastTerm2"
OPTS=["-p",str(PORT),"-oHostKeyAlgorithms=+ssh-rsa","-oPubkeyAcceptedAlgorithms=+ssh-rsa",
  "-oKexAlgorithms=+diffie-hellman-group-exchange-sha256,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1",
  "-oStrictHostKeyChecking=no","-oUserKnownHostsFile=/dev/null","-oConnectTimeout=10",
  "-oNumberOfPasswordPrompts=1","-oLogLevel=ERROR"]

def _pty(argv, feed=None, done=b"===DONE===", timeout=60):
    pid,fd=pty.fork()
    if pid==0: os.execvp(argv[0],argv); os._exit(127)
    buf=b"";sent=False;fed=False;dl=time.time()+timeout
    while time.time()<dl:
        r,_,_=select.select([fd],[],[],1.0)
        if fd in r:
            try:d=os.read(fd,4096)
            except OSError:break
            if not d:break
            buf+=d
            if not sent and b"assword" in buf: os.write(fd,(PW+"\n").encode());sent=True
            elif sent and not fed and feed and (b"sftp>" in buf or b"Connected" in buf):
                os.write(fd,feed.encode());fed=True
        if done and done in buf: break
    try:os.close(fd)
    except OSError:pass
    try:os.waitpid(pid,0)
    except OSError:pass
    return buf.decode("utf-8","replace")

def put(local, remote):
    b=f"put {local} {remote}\nbye\n"
    sftp_opts=["-P",str(PORT)]+OPTS[2:]   # sftp uses -P for port, not -p
    return _pty(["sftp",*sftp_opts,f"{USER}@{HOST}"],feed=b,done=None,timeout=60)

def sh(cmd, timeout=60):
    return _pty(["ssh",*OPTS,f"{USER}@{HOST}",cmd+'; echo "===DONE==="'],timeout=timeout)

def bg(cmd, timeout=15):
    # launch detached on device, return immediately
    wrapped = f"setsid sh -c '{cmd}' >/tmp/mz.log 2>&1 < /dev/null & echo STARTED pid=$!; echo '===DONE==='"
    return _pty(["ssh",*OPTS,f"{USER}@{HOST}",wrapped],timeout=timeout)

if __name__=="__main__":
    m=sys.argv[1]
    if m=="put": print(put(sys.argv[2],sys.argv[3]))
    elif m=="sh": print(sh(sys.argv[2], int(os.environ.get("T","60"))))
    elif m=="bg": print(bg(sys.argv[2]))
