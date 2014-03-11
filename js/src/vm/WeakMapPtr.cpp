/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "js/WeakMapPtr.h"

#include "jsweakmap.h"

//
// Machinery for the externally-linkable JS::WeakMapPtr, which wraps js::WeakMap
// for a few public data types.
//

using namespace js;

namespace {

template<typename T>
struct DataType
{
};

template<>
struct DataType<JSObject*>
{
    typedef EncapsulatedPtrObject Encapsulated;
    static JSObject *NullValue() { return nullptr; }
};

template<>
struct DataType<JS::Value>
{
    typedef EncapsulatedValue Encapsulated;
    static JS::Value NullValue() { return JS::UndefinedValue(); }
};

template <typename K, typename V>
struct Utils
{
    typedef typename DataType<K>::Encapsulated KeyType;
    typedef typename DataType<V>::Encapsulated ValueType;
    typedef WeakMap<KeyType, ValueType> Type;
    typedef Type* PtrType;
    static PtrType cast(void *ptr) { return static_cast<PtrType>(ptr); }
};

} /* namespace */

template <typename K, typename V>
void
JS::WeakMapPtr<K, V>::destroy()
{
    MOZ_ASSERT(initialized());
    auto map = Utils<K, V>::cast(ptr);
    // If this destruction happens mid-GC, we might be in the compartment's list
    // of known live weakmaps. If we are, remove ourselves before deleting.
    if (map->isInList())
        WeakMapBase::removeWeakMapFromList(map);
    map->check();
    js_delete(map);
    ptr = nullptr;
}

template <typename K, typename V>
bool
JS::WeakMapPtr<K, V>::init(JSContext *cx)
{
    MOZ_ASSERT(!initialized());
    typename Utils<K, V>::PtrType map = cx->runtime()->new_<typename Utils<K,V>::Type>(cx);
    if (!map || !map->init())
        return false;
    ptr = map;
    return true;
}

template <typename K, typename V>
void
JS::WeakMapPtr<K, V>::trace(JSTracer *trc)
{
    MOZ_ASSERT(initialized());
    return Utils<K, V>::cast(ptr)->trace(trc);
}

template <typename K, typename V>
V
JS::WeakMapPtr<K, V>::lookup(const K &key)
{
    MOZ_ASSERT(initialized());
    typename Utils<K, V>::Type::Ptr result = Utils<K, V>::cast(ptr)->lookup(key);
    if (!result)
        return DataType<V>::NullValue();
    return result->value();
}

template <typename K, typename V>
bool
JS::WeakMapPtr<K, V>::put(const K &key, const V &value)
{
    MOZ_ASSERT(initialized());
    return Utils<K, V>::cast(ptr)->put(key, value);
}

//
// Supported specializations of JS::WeakMap:
//

template class JS::WeakMapPtr<JSObject*, JSObject*>;

#ifdef DEBUG
// Nobody's using this at the moment, but we want to make sure it compiles.
template class JS::WeakMapPtr<JSObject*, JS::Value>;
#endif
