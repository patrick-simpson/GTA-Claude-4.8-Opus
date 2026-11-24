import traceback, time, os, glob
D = r"C:\Users\User\Documents\GitHub\GTA-Claude-4.8-Opus\scratch\renderdoc" + "\\"
f = open(D + "log_loop.txt", "w")
def log(s):
    f.write(s + "\n"); f.flush()
try:
    import renderdoc as rd
    ident = rd.EnumerateRemoteTargets("localhost", 0)
    tc = rd.CreateTargetControl("localhost", ident, "claude", True)
    log("target pid %d" % tc.GetPID())
    while not os.path.exists(D + "quit.txt"):
        reqs = glob.glob(D + "req_*.txt")
        if not reqs:
            tc.ReceiveMessage(None); time.sleep(0.2); continue
        r = reqs[0]; name = open(r).read().strip(); os.remove(r)
        tc.TriggerCapture(1)
        t0 = time.time(); ok = False
        while time.time() - t0 < 30:
            m = tc.ReceiveMessage(None)
            if m.type == rd.TargetControlMessageType.NewCapture:
                tc.CopyCapture(m.newCapture.captureId, D + name + ".rdc")
            elif m.type == rd.TargetControlMessageType.CaptureCopied:
                ok = True; break
        log("%s %s" % (name, ok)); open(D + "done_" + name + ".txt", "w").write(str(ok))
    tc.Shutdown()
except Exception:
    log(traceback.format_exc())
f.close()
