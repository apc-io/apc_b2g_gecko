/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=4 sw=4 et tw=99:
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#if !defined(jsion_asmjs_h__)
#define jsion_asmjs_h__

// asm.js compilation is only available on desktop x86/x64 at the moment.
// Don't panic, mobile support is coming soon.
#if defined(JS_ION) && \
    !defined(ANDROID) && \
    (defined(JS_CPU_X86) || defined(JS_CPU_X64)) &&  \
    (defined(__linux__) || defined(XP_WIN))
# define JS_ASMJS
#endif

namespace js {

class SPSProfiler;
class AsmJSModule;
namespace frontend { struct TokenStream; struct ParseNode; }

// Return whether asm.js optimization is inhibitted by the platform or
// dynamically disabled. (Exposed as JSNative for shell testing.)
extern JSBool
IsAsmJSCompilationAvailable(JSContext *cx, unsigned argc, Value *vp);

// Called after parsing a function 'fn' which contains the "use asm" directive.
// This function performs type-checking and code-generation. If type-checking
// succeeds, the generated module is assigned to script->asmJS. Otherwise, a
// warning will be emitted and script->asmJS is left null. The function returns
// 'false' only if a real JS semantic error (probably OOM) is pending.
extern bool
CompileAsmJS(JSContext *cx, frontend::TokenStream &ts, frontend::ParseNode *fn, HandleScript s);

// Called by the JSOP_LINKASMJS opcode (which is emitted as the first opcode of
// a "use asm" function which successfully typechecks). This function performs
// the validation and dynamic linking of a module to it's given arguments. If
// validation succeeds, the module's return value (it's exports) are returned
// as an object in 'rval' and the interpreter should return 'rval' immediately.
// Otherwise, there was a validation error and execution should continue
// normally in the interpreter. The function returns 'false' only if a real JS
// semantic error (OOM or exception thrown when executing GetProperty on the
// arguments) is pending.
extern bool
LinkAsmJS(JSContext *cx, StackFrame *fp, MutableHandleValue rval);

// Force any currently-executing asm.js code to call
// js_HandleExecutionInterrupt.
void
TriggerOperationCallbackForAsmJSCode(JSRuntime *rt);

// The JSRuntime maintains a stack of AsmJSModule activations. An "activation"
// of module A is an initial call from outside A into a function inside A,
// followed by a sequence of calls inside A, and terminated by a call that
// leaves A. The AsmJSActivation stack serves three purposes:
//  - record the correct cx to pass to VM calls from asm.js;
//  - record enough information to pop all the frames of an activation if an
//    exception is thrown;
//  - record the information necessary for asm.js signal handlers to safely
//    recover from (expected) out-of-bounds access, the operation callback,
//    stack overflow, division by zero, etc.
class AsmJSActivation
{
    JSContext *cx_;
    const AsmJSModule &module_;
    unsigned entryIndex_;
    AsmJSActivation *prev_;
    void *errorRejoinSP_;
    SPSProfiler *profiler_;
    void *resumePC_;

  public:
    AsmJSActivation(JSContext *cx, const AsmJSModule &module, unsigned entryIndex);
    ~AsmJSActivation();

    const AsmJSModule &module() const { return module_; }

    // Read by JIT code:
    static unsigned offsetOfContext() { return offsetof(AsmJSActivation, cx_); }
    static unsigned offsetOfResumePC() { return offsetof(AsmJSActivation, resumePC_); }

    // Initialized by JIT code:
    static unsigned offsetOfErrorRejoinSP() { return offsetof(AsmJSActivation, errorRejoinSP_); }

    // Set from SIGSEGV handler:
    void setResumePC(void *pc) { resumePC_ = pc; }
};

// The asm.js spec requires that the ArrayBuffer's byteLength be a multiple of 4096.
static const size_t AsmJSAllocationGranularity = 4096;

// On x64, the internal ArrayBuffer data array is inflated to 4GiB (only the
// byteLength portion of which is accessible) so that out-of-bounds accesses
// (made using a uint32 index) are guaranteed to raise a SIGSEGV.
# ifdef JS_CPU_X64
static const size_t AsmJSBufferProtectedSize = 4 * 1024ULL * 1024ULL * 1024ULL;
# endif

} // namespace js

#endif // jsion_asmjs_h__
