import traceback, json, os, sys
D = r"C:\Users\User\Documents\GitHub\GTA-Claude-4.8-Opus\scratch\renderdoc" + "\\"
names = open(D + "an_names.txt").read().split()
f = open(D + "log_an.txt", "w")
def log(s): f.write(s + "\n"); f.flush()
try:
    import renderdoc as rd
    rd.InitialiseReplay(rd.GlobalEnvironment(), [])
except Exception:
    log("init " + traceback.format_exc())
def flat(acts, out):
    for a in acts:
        out.append(a); flat(a.children, out)
for name in names:
    try:
        cap = rd.OpenCaptureFile(); r = cap.OpenFile(D + name + ".rdc", "", None)
        if r != rd.ResultCode.Succeeded: log("open fail %s %s" % (name, r)); continue
        res, ctl = cap.OpenCapture(rd.ReplayOptions(), None)
        if res != rd.ResultCode.Succeeded: log("replay fail %s %s" % (name, res)); continue
        tex = {t.resourceId: t for t in ctl.GetTextures()}
        acts = []; flat(ctl.GetRootActions(), acts)
        counters = ctl.FetchCounters([rd.GPUCounter.EventGPUDuration])
        dur = {}
        for c in counters:
            dur[c.eventId] = dur.get(c.eventId, 0) + c.value.d
        sdf = ctl.GetStructuredFile()
        rows = []
        AF = rd.ActionFlags
        for a in acts:
            fl = a.flags
            if not (fl & (AF.Drawcall | AF.Clear | AF.Dispatch | AF.Copy | AF.Resolve | AF.GenMips)): continue
            ctl.SetFrameEvent(a.eventId, False)
            st = ctl.GetPipelineState()
            outs = [o.resource for o in st.GetOutputTargets() if o.resource != rd.ResourceId.Null()]
            dp = st.GetDepthTarget().resource
            def sz(rid):
                t = tex.get(rid); return "%dx%d" % (t.width, t.height) if t else "?"
            ps = st.GetShader(rd.ShaderStage.Pixel)
            try:
                bl = st.GetColorBlends(); blend = 1 if (len(bl) and bl[0].enabled) else 0
            except Exception: blend = -1
            try: dw = 1 if st.GetDepthState().depthWrites else 0
            except Exception: dw = -1
            key = "%s|%s" % (",".join(str(o) for o in outs), str(dp))
            rows.append({"e": a.eventId, "n": a.GetName(sdf), "idx": a.numIndices, "inst": a.numInstances,
                         "k": key, "sz": sz(outs[0]) if outs else (sz(dp) if dp != rd.ResourceId.Null() else "-"),
                         "nout": len(outs), "ps": str(ps), "blend": blend, "dw": dw, "vtx": a.numIndices, "d": dur.get(a.eventId, 0), "fl": int(fl)})
        json.dump(rows, open(D + name + ".json", "w"))
        log("%s ok actions %d total %.3f ms" % (name, len(rows), sum(dur.values()) * 1000))
        ctl.Shutdown(); cap.Shutdown()
    except Exception:
        log(name + " " + traceback.format_exc())
log("done")
f.close()
