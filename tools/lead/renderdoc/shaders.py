import traceback, json
D = r"C:\Users\User\Documents\GitHub\GTA-Claude-4.8-Opus\scratch\renderdoc" + "\\"
f = open(D + "shaders.txt", "w")
def log(s): f.write(s + "\n"); f.flush()
try:
    import renderdoc as rd
    rd.InitialiseReplay(rd.GlobalEnvironment(), [])
    rows = json.load(open(D + "downtown.json"))
    main = [r for r in rows if r["idx"] > 0 and r["sz"] == "1899x769"]
    agg = {}
    for r in main:
        a = agg.setdefault(r["ps"], [0, 0, r["e"]]); a[0] += r["d"]; a[1] += 1
    top = sorted(agg.items(), key=lambda kv: -kv[1][0])[:7]
    cap = rd.OpenCaptureFile(); cap.OpenFile(D + "downtown.rdc", "", None)
    res, ctl = cap.OpenCapture(rd.ReplayOptions(), None)
    names = {r.resourceId: r.name for r in ctl.GetResources()}
    for ps, (d, n, ev) in top:
        ctl.SetFrameEvent(ev, False)
        st = ctl.GetPipelineState()
        sh = st.GetShader(rd.ShaderStage.Pixel)
        refl = st.GetShaderReflection(rd.ShaderStage.Pixel)
        pipe = st.GetGraphicsPipelineObject()
        log("=== %s %.2fms draws %d ev %d" % (ps, d * 1000, n, ev))
        log("  ro %d rw %d cb %d inputs %s" % (len(refl.readOnlyResources), len(refl.readWriteResources), len(refl.constantBlocks), [s.varName for s in refl.inputSignature]))
        log("  resources " + ",".join(r.name for r in refl.readOnlyResources))
        for cb in refl.constantBlocks:
            log("  cb %s vars %s" % (cb.name, [v.name for v in cb.variables][:30]))
        try:
            dis = ctl.DisassembleShader(pipe, refl, "")
            lines = dis.split("\n")
            log("  disasm lines %d; instr count approx %d" % (len(lines), len([l for l in lines if l.strip() and l.strip()[0].isdigit()])))
            log("  sample: " + " | ".join(l.strip() for l in lines[:6]))
        except Exception as e:
            log("  disasm fail " + str(e))
    log("done")
except Exception:
    log(traceback.format_exc())
f.close()
