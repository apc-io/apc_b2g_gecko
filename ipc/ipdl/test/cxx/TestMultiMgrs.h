#ifndef mozilla__ipdltest_TestMultiMgrs_h
#define mozilla__ipdltest_TestMultiMgrs_h 1

#include "mozilla/_ipdltest/IPDLUnitTests.h"

#include "mozilla/_ipdltest/PTestMultiMgrsParent.h"
#include "mozilla/_ipdltest/PTestMultiMgrsChild.h"
#include "mozilla/_ipdltest/PTestMultiMgrsBottomParent.h"
#include "mozilla/_ipdltest/PTestMultiMgrsBottomChild.h"
#include "mozilla/_ipdltest/PTestMultiMgrsLeftParent.h"
#include "mozilla/_ipdltest/PTestMultiMgrsLeftChild.h"
#include "mozilla/_ipdltest/PTestMultiMgrsRightParent.h"
#include "mozilla/_ipdltest/PTestMultiMgrsRightChild.h"

namespace mozilla {
namespace _ipdltest {

//-----------------------------------------------------------------------------
// Parent side
//

class TestMultiMgrsBottomParent :
    public PTestMultiMgrsBottomParent
{
public:
    TestMultiMgrsBottomParent() { }
    virtual ~TestMultiMgrsBottomParent() { }
};

class TestMultiMgrsLeftParent :
    public PTestMultiMgrsLeftParent
{
public:
    TestMultiMgrsLeftParent() { }
    virtual ~TestMultiMgrsLeftParent() { }

    bool HasChild(TestMultiMgrsBottomParent* c)
    {
        return ManagedPTestMultiMgrsBottomParent().Contains(c);
    }

protected:
    virtual PTestMultiMgrsBottomParent* AllocPTestMultiMgrsBottomParent() MOZ_OVERRIDE
    {
        return new TestMultiMgrsBottomParent();
    }

    virtual bool DeallocPTestMultiMgrsBottomParent(PTestMultiMgrsBottomParent* actor) MOZ_OVERRIDE
    {
        delete actor;
        return true;
    }
};

class TestMultiMgrsRightParent :
    public PTestMultiMgrsRightParent
{
public:
    TestMultiMgrsRightParent() { }
    virtual ~TestMultiMgrsRightParent() { }

    bool HasChild(TestMultiMgrsBottomParent* c)
    {
        return ManagedPTestMultiMgrsBottomParent().Contains(c);
    }

protected:
    virtual PTestMultiMgrsBottomParent* AllocPTestMultiMgrsBottomParent() MOZ_OVERRIDE
    {
        return new TestMultiMgrsBottomParent();
    }

    virtual bool DeallocPTestMultiMgrsBottomParent(PTestMultiMgrsBottomParent* actor) MOZ_OVERRIDE
    {
        delete actor;
        return true;
    }
};

class TestMultiMgrsParent :
    public PTestMultiMgrsParent
{
public:
    TestMultiMgrsParent() { }
    virtual ~TestMultiMgrsParent() { }

    static bool RunTestInProcesses() { return true; }
    static bool RunTestInThreads() { return true; }

    void Main();

protected:
    virtual bool RecvOK() MOZ_OVERRIDE;

    virtual PTestMultiMgrsLeftParent* AllocPTestMultiMgrsLeftParent() MOZ_OVERRIDE
    {
        return new TestMultiMgrsLeftParent();
    }

    virtual bool DeallocPTestMultiMgrsLeftParent(PTestMultiMgrsLeftParent* actor) MOZ_OVERRIDE
    {
        delete actor;
        return true;
    }

    virtual PTestMultiMgrsRightParent* AllocPTestMultiMgrsRightParent() MOZ_OVERRIDE
    {
        return new TestMultiMgrsRightParent();
    }

    virtual bool DeallocPTestMultiMgrsRightParent(PTestMultiMgrsRightParent* actor) MOZ_OVERRIDE
    {
        delete actor;
        return true;
    }

    virtual void ActorDestroy(ActorDestroyReason why) MOZ_OVERRIDE
    {
        if (NormalShutdown != why)
            fail("unexpected destruction!");  
        passed("ok");
        QuitParent();
    }
};

//-----------------------------------------------------------------------------
// Child side
//

class TestMultiMgrsBottomChild :
    public PTestMultiMgrsBottomChild
{
public:
    TestMultiMgrsBottomChild() { }
    virtual ~TestMultiMgrsBottomChild() { }
};

class TestMultiMgrsLeftChild :
    public PTestMultiMgrsLeftChild
{
public:
    TestMultiMgrsLeftChild() { }
    virtual ~TestMultiMgrsLeftChild() { }

    bool HasChild(PTestMultiMgrsBottomChild* c)
    {
        return ManagedPTestMultiMgrsBottomChild().Contains(c);
    }

protected:
    virtual bool RecvPTestMultiMgrsBottomConstructor(PTestMultiMgrsBottomChild* actor) MOZ_OVERRIDE;

    virtual PTestMultiMgrsBottomChild* AllocPTestMultiMgrsBottomChild() MOZ_OVERRIDE
    {
        return new TestMultiMgrsBottomChild();
    }

    virtual bool DeallocPTestMultiMgrsBottomChild(PTestMultiMgrsBottomChild* actor) MOZ_OVERRIDE
    {
        delete actor;
        return true;
    }
};

class TestMultiMgrsRightChild :
    public PTestMultiMgrsRightChild
{
public:
    TestMultiMgrsRightChild() { }
    virtual ~TestMultiMgrsRightChild() { }

    bool HasChild(PTestMultiMgrsBottomChild* c)
    {
        return ManagedPTestMultiMgrsBottomChild().Contains(c);
    }

protected:
    virtual bool RecvPTestMultiMgrsBottomConstructor(PTestMultiMgrsBottomChild* actor) MOZ_OVERRIDE;

    virtual PTestMultiMgrsBottomChild* AllocPTestMultiMgrsBottomChild() MOZ_OVERRIDE
    {
        return new TestMultiMgrsBottomChild();
    }

    virtual bool DeallocPTestMultiMgrsBottomChild(PTestMultiMgrsBottomChild* actor) MOZ_OVERRIDE
    {
        delete actor;
        return true;
    }
};

class TestMultiMgrsChild :
    public PTestMultiMgrsChild
{
public:
    TestMultiMgrsChild() { }
    virtual ~TestMultiMgrsChild() { }

    void Main();

    PTestMultiMgrsBottomChild* mBottomL;
    PTestMultiMgrsBottomChild* mBottomR;

protected:
    virtual bool RecvCheck() MOZ_OVERRIDE;

    virtual PTestMultiMgrsLeftChild* AllocPTestMultiMgrsLeftChild() MOZ_OVERRIDE
    {
        return new TestMultiMgrsLeftChild();
    }

    virtual bool DeallocPTestMultiMgrsLeftChild(PTestMultiMgrsLeftChild* actor) MOZ_OVERRIDE
    {
        delete actor;
        return true;
    }

    virtual PTestMultiMgrsRightChild* AllocPTestMultiMgrsRightChild() MOZ_OVERRIDE
    {
        return new TestMultiMgrsRightChild();
    }

    virtual bool DeallocPTestMultiMgrsRightChild(PTestMultiMgrsRightChild* actor) MOZ_OVERRIDE
    {
        delete actor;
        return true;
    }

    virtual void ActorDestroy(ActorDestroyReason why) MOZ_OVERRIDE
    {
        if (NormalShutdown != why)
            fail("unexpected destruction!");  
        passed("ok");
        QuitChild();
    }
};


} // namespace _ipdltest
} // namespace mozilla


#endif // ifndef mozilla__ipdltest_TestMultiMgrs_h
