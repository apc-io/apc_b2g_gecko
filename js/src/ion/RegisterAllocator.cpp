/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=4 sw=4 et tw=99:
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RegisterAllocator.h"

using namespace js;
using namespace js::ion;

bool
AllocationIntegrityState::record()
{
    // Ignore repeated record() calls.
    if (!instructions.empty())
        return true;

    if (!instructions.reserve(graph.numInstructions()))
        return false;
    for (size_t i = 0; i < graph.numInstructions(); i++)
        instructions.infallibleAppend(InstructionInfo());

    if (!virtualRegisters.reserve(graph.numVirtualRegisters()))
        return false;
    for (size_t i = 0; i < graph.numVirtualRegisters(); i++)
        virtualRegisters.infallibleAppend(NULL);

    if (!blocks.reserve(graph.numBlocks()))
        return false;
    for (size_t i = 0; i < graph.numBlocks(); i++) {
        blocks.infallibleAppend(BlockInfo());
        LBlock *block = graph.getBlock(i);
        JS_ASSERT(block->mir()->id() == i);

        BlockInfo &blockInfo = blocks[i];
        if (!blockInfo.phis.reserve(block->numPhis()))
            return false;

        for (size_t j = 0; j < block->numPhis(); j++) {
            blockInfo.phis.infallibleAppend(InstructionInfo());
            InstructionInfo &info = blockInfo.phis[j];
            LPhi *phi = block->getPhi(j);
            for (size_t k = 0; k < phi->numDefs(); k++) {
                uint32 vreg = phi->getDef(k)->virtualRegister();
                virtualRegisters[vreg] = phi->getDef(k);
                if (!info.outputs.append(vreg))
                    return false;
            }
            for (size_t k = 0; k < phi->numOperands(); k++) {
                if (!info.inputs.append(phi->getOperand(k)->toUse()->virtualRegister()))
                    return false;
            }
        }

        for (LInstructionIterator iter = block->begin(); iter != block->end(); iter++) {
            LInstruction *ins = *iter;
            InstructionInfo &info = instructions[ins->id()];

            for (size_t k = 0; k < ins->numDefs(); k++) {
                uint32 vreg = ins->getDef(k)->virtualRegister();
                virtualRegisters[vreg] = ins->getDef(k);
                if (!info.outputs.append(vreg))
                    return false;
            }
            for (LInstruction::InputIterator alloc(*ins); alloc.more(); alloc.next()) {
                if (!info.inputs.append(alloc->isUse() ? alloc->toUse()->virtualRegister() : UINT32_MAX))
                    return false;
            }
        }
    }

    return seen.init();
}

bool
AllocationIntegrityState::check(bool populateSafepoints)
{
    JS_ASSERT(!instructions.empty());

#ifdef DEBUG
    for (size_t blockIndex = 0; blockIndex < graph.numBlocks(); blockIndex++) {
        LBlock *block = graph.getBlock(blockIndex);

        // Check that all instruction inputs and outputs have been assigned an allocation.
        for (LInstructionIterator iter = block->begin(); iter != block->end(); iter++) {
            LInstruction *ins = *iter;

            for (LInstruction::InputIterator alloc(*ins); alloc.more(); alloc.next())
                JS_ASSERT(!alloc->isUse());

            for (size_t i = 0; i < ins->numDefs(); i++) {
                LDefinition *def = ins->getDef(i);
                JS_ASSERT_IF(def->policy() != LDefinition::PASSTHROUGH, !def->output()->isUse());

                if (def->output()->isRegister()) {
                    // The live regs for an instruction's safepoint should
                    // exclude the instruction's definitions.
                    LSafepoint *safepoint = ins->safepoint();
                    JS_ASSERT_IF(safepoint, !safepoint->liveRegs().has(def->output()->toRegister()));
                }
            }
        }
    }
#endif

    // Check that the register assignment and move groups preserve the original
    // semantics of the virtual registers. Each virtual register has a single
    // write (owing to the SSA representation), but the allocation may move the
    // written value around between registers and memory locations along
    // different paths through the script.
    //
    // For each use of an allocation, follow the physical value which is read
    // backward through the script, along all paths to the value's virtual
    // register's definition.
    for (size_t blockIndex = 0; blockIndex < graph.numBlocks(); blockIndex++) {
        LBlock *block = graph.getBlock(blockIndex);
        for (LInstructionIterator iter = block->begin(); iter != block->end(); iter++) {
            LInstruction *ins = *iter;
            const InstructionInfo &info = instructions[ins->id()];

            size_t inputIndex = 0;
            for (LInstruction::InputIterator alloc(*ins); alloc.more(); alloc.next()) {
                uint32 vreg = info.inputs[inputIndex++];
                if (vreg == UINT32_MAX)
                    continue;

                // Start checking at the previous instruction, in case this
                // instruction reuses its input register for an output.
                LInstructionReverseIterator riter = block->rbegin(ins);
                riter++;
                checkIntegrity(block, *riter, vreg, **alloc, populateSafepoints);

                while (!worklist.empty()) {
                    IntegrityItem item = worklist.back();
                    worklist.popBack();
                    checkIntegrity(item.block, *item.block->rbegin(), item.vreg, item.alloc, populateSafepoints);
                }
            }
        }
    }

    if (IonSpewEnabled(IonSpew_RegAlloc))
        dump();

    return true;
}

bool
AllocationIntegrityState::checkIntegrity(LBlock *block, LInstruction *ins,
                                         uint32 vreg, LAllocation alloc, bool populateSafepoints)
{
    for (LInstructionReverseIterator iter(block->rbegin(ins)); iter != block->rend(); iter++) {
        ins = *iter;

        // Follow values through assignments in move groups. All assignments in
        // a move group are considered to happen simultaneously, so stop after
        // the first matching move is found.
        if (ins->isMoveGroup()) {
            LMoveGroup *group = ins->toMoveGroup();
            for (int i = group->numMoves() - 1; i >= 0; i--) {
                if (*group->getMove(i).to() == alloc) {
                    alloc = *group->getMove(i).from();
                    break;
                }
            }
        }

        const InstructionInfo &info = instructions[ins->id()];

        // Make sure the physical location being tracked is not clobbered by
        // another instruction, and that if the originating vreg definition is
        // found that it is writing to the tracked location.

        for (size_t i = 0; i < ins->numDefs(); i++) {
            LDefinition *def = ins->getDef(i);
            if (def->policy() == LDefinition::PASSTHROUGH)
                continue;
            if (info.outputs[i] == vreg) {
                check(*def->output() == alloc,
                      "Found vreg definition, but tracked value does not match");

                // Found the original definition, done scanning.
                return true;
            } else {
                check(*def->output() != alloc,
                      "Tracked value clobbered by intermediate definition");
            }
        }

        for (size_t i = 0; i < ins->numTemps(); i++) {
            LDefinition *temp = ins->getTemp(i);
            if (!temp->isBogusTemp()) {
                check(*temp->output() != alloc,
                      "Tracked value clobbered by intermediate temporary");
            }
        }

        LSafepoint *safepoint = ins->safepoint();
        if (!safepoint)
            continue;

        if (alloc.isRegister()) {
            AnyRegister reg = alloc.toRegister();
            if (populateSafepoints)
                safepoint->addLiveRegister(reg);
            else
                check(safepoint->liveRegs().has(reg), "Register not marked in safepoint");
        }

        LDefinition::Type type = virtualRegisters[vreg]
                                 ? virtualRegisters[vreg]->type()
                                 : LDefinition::GENERAL;

        switch (type) {
          case LDefinition::OBJECT:
            if (populateSafepoints)
                safepoint->addGcPointer(alloc);
            else
                check(safepoint->hasGcPointer(alloc), "GC register not marked in safepoint");
            break;
#ifdef JS_NUNBOX32
          // If a vreg for a value's components are copied in multiple places
          // then the safepoint information may be incomplete and not reflect
          // all copies. See SafepointWriter::writeNunboxParts.
          case LDefinition::TYPE:
            if (populateSafepoints)
                safepoint->addNunboxType(vreg, alloc);
            break;
          case LDefinition::PAYLOAD:
            if (populateSafepoints)
                safepoint->addNunboxPayload(vreg, alloc);
            break;
#else
          case LDefinition::BOX:
            if (populateSafepoints)
                safepoint->addBoxedValue(alloc);
            else
                check(safepoint->hasBoxedValue(alloc), "Boxed value not marked in safepoint");
            break;
#endif
          default:
            break;
        }
    }

    // Phis are effectless, but change the vreg we are tracking. Check if there
    // is one which produced this vreg. We need to follow back through the phi
    // inputs as it is not guaranteed the register allocator filled in physical
    // allocations for the inputs and outputs of the phis.
    for (size_t i = 0; i < block->numPhis(); i++) {
        InstructionInfo &info = blocks[block->mir()->id()].phis[i];
        LPhi *phi = block->getPhi(i);
        if (info.outputs[0] == vreg) {
            for (size_t j = 0; j < phi->numOperands(); j++) {
                uint32 newvreg = info.inputs[j];
                LBlock *predecessor = graph.getBlock(block->mir()->getPredecessor(j)->id());
                if (!addPredecessor(predecessor, newvreg, alloc))
                    return false;
            }
            return true;
        }
    }

    // No phi which defined the vreg we are tracking, follow back through all
    // predecessors with the existing vreg.
    for (size_t i = 0; i < block->mir()->numPredecessors(); i++) {
        LBlock *predecessor = graph.getBlock(block->mir()->getPredecessor(i)->id());
        if (!addPredecessor(predecessor, vreg, alloc))
            return false;
    }

    return true;
}

bool
AllocationIntegrityState::addPredecessor(LBlock *block, uint32 vreg, LAllocation alloc)
{
    // There is no need to reanalyze if we have already seen this predecessor.
    // We share the seen allocations across analysis of each use, as there will
    // likely be common ground between different uses of the same vreg.
    IntegrityItem item;
    item.block = block;
    item.vreg = vreg;
    item.alloc = alloc;
    item.index = seen.count();

    IntegrityItemSet::AddPtr p = seen.lookupForAdd(item);
    if (p)
        return true;
    if (!seen.add(p, item))
        return false;

    return worklist.append(item);
}

void
AllocationIntegrityState::check(bool cond, const char *msg)
{
  if (!cond) {
    if (IonSpewEnabled(IonSpew_RegAlloc))
      dump();
    printf("%s\n", msg);
    JS_NOT_REACHED("Regalloc integrity failure");
  }
}

void
AllocationIntegrityState::dump()
{
#ifdef DEBUG
    printf("Register Allocation:\n");

    for (size_t blockIndex = 0; blockIndex < graph.numBlocks(); blockIndex++) {
        LBlock *block = graph.getBlock(blockIndex);
        MBasicBlock *mir = block->mir();

        printf("\nBlock %lu", blockIndex);
        for (size_t i = 0; i < mir->numSuccessors(); i++)
            printf(" [successor %u]", mir->getSuccessor(i)->id());
        printf("\n");

        for (size_t i = 0; i < block->numPhis(); i++) {
            InstructionInfo &info = blocks[blockIndex].phis[i];
            LPhi *phi = block->getPhi(i);

            printf("Phi v%u <-", info.outputs[0]);
            for (size_t j = 0; j < phi->numOperands(); j++)
                printf(" v%u", info.inputs[j]);
            printf("\n");
        }

        for (LInstructionIterator iter = block->begin(); iter != block->end(); iter++) {
            LInstruction *ins = *iter;
            InstructionInfo &info = instructions[ins->id()];

            printf("[%s]", ins->opName());

            if (ins->isMoveGroup()) {
                LMoveGroup *group = ins->toMoveGroup();
                for (int i = group->numMoves() - 1; i >= 0; i--) {
                    printf(" [");
                    LAllocation::PrintAllocation(stdout, group->getMove(i).from());
                    printf(" -> ");
                    LAllocation::PrintAllocation(stdout, group->getMove(i).to());
                    printf("]");
                }
                printf("\n");
                continue;
            }

            for (size_t i = 0; i < ins->numTemps(); i++) {
                LDefinition *temp = ins->getTemp(i);
                if (!temp->isBogusTemp()) {
                    printf(" [temp ");
                    LAllocation::PrintAllocation(stdout, temp->output());
                    printf("]");
                }
            }

            for (size_t i = 0; i < ins->numDefs(); i++) {
                LDefinition *def = ins->getDef(i);
                printf(" [def v%u ", info.outputs[i]);
                LAllocation::PrintAllocation(stdout, def->output());
                printf("]");
            }

            size_t index = 0;
            for (LInstruction::InputIterator alloc(*ins); alloc.more(); alloc.next()) {
                uint32 vreg = info.inputs[index++];
                if (vreg == UINT32_MAX)
                    continue;
                printf(" [use v%u ", vreg);
                LAllocation::PrintAllocation(stdout, *alloc);
                printf("]");
            }

            printf("\n");
        }
    }

    printf("\nIntermediate Allocations:\n\n");

    // Print discovered allocations at the ends of blocks, in the order they
    // were discovered.

    Vector<IntegrityItem, 20, SystemAllocPolicy> seenOrdered;
    for (size_t i = 0; i < seen.count(); i++)
        seenOrdered.append(IntegrityItem());

    for (IntegrityItemSet::Enum iter(seen); !iter.empty(); iter.popFront()) {
        IntegrityItem item = iter.front();
        seenOrdered[item.index] = item;
    }

    for (size_t i = 0; i < seenOrdered.length(); i++) {
        IntegrityItem item = seenOrdered[i];
        printf("block %u reg v%u alloc ", item.block->mir()->id(), item.vreg);
        LAllocation::PrintAllocation(stdout, &item.alloc);
        printf("\n");
    }

    printf("\n");
#endif
}

const CodePosition CodePosition::MAX(UINT_MAX);
const CodePosition CodePosition::MIN(0);

bool
RegisterAllocator::init()
{
    if (!insData.init(lir->mir(), graph.numInstructions()))
        return false;

    for (size_t i = 0; i < graph.numBlocks(); i++) {
        LBlock *block = graph.getBlock(i);
        for (LInstructionIterator ins = block->begin(); ins != block->end(); ins++)
            insData[*ins].init(*ins, block);
        for (size_t j = 0; j < block->numPhis(); j++) {
            LPhi *phi = block->getPhi(j);
            insData[phi].init(phi, block);
        }
    }

    return true;
}

LMoveGroup *
RegisterAllocator::getInputMoveGroup(uint32 ins)
{
    InstructionData *data = &insData[ins];
    JS_ASSERT(!data->ins()->isPhi());
    JS_ASSERT(!data->ins()->isLabel());

    if (data->inputMoves())
        return data->inputMoves();

    LMoveGroup *moves = new LMoveGroup;
    data->setInputMoves(moves);
    data->block()->insertBefore(data->ins(), moves);

    return moves;
}

LMoveGroup *
RegisterAllocator::getMoveGroupAfter(uint32 ins)
{
    InstructionData *data = &insData[ins];
    JS_ASSERT(!data->ins()->isPhi());

    if (data->movesAfter())
        return data->movesAfter();

    LMoveGroup *moves = new LMoveGroup;
    data->setMovesAfter(moves);

    if (data->ins()->isLabel())
        data->block()->insertAfter(data->block()->getEntryMoveGroup(), moves);
    else
        data->block()->insertAfter(data->ins(), moves);
    return moves;
}
