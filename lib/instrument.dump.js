(function() {
    
    var window = this;
    var undefined;
    
    var _hasOwnProperty = {}.hasOwnProperty;
    function hasPrty(obj, x) {
        return _hasOwnProperty.__jsnapHiddenProp__call(obj,x);
    }

    var _Object = Object;
    var defineProperty = Object.defineProperty;
    function defineHiddenProperty(obj, prop, val) {
        try {
            defineProperty.__jsnapHiddenProp__call(_Object, obj, prop,
                {
                    enumerable: false,
                    configurable: false,
                    writable: false,
                    value: val
                });
        } catch (e) {
            obj[prop] = val;
        }
    }
    
    var immutableObjectKeys = [];
    var immutableObjects = [];
    var nextKey = 1;
    function lookupImmutableObj(obj) {
        var len = immutableObjects.length;
        for (var i=0; i<len; ++i) {
            if (immutableObjects[i] === obj)
                return immutableObjectKeys[i];
        }
        var key = nextKey++;
        immutableObjects.push(obj)
        immutableObjectKeys.push(key)
        return key;
    }
    function getKey(obj) {
        if (!hasPrty(obj, "__jsnapHiddenProp__key")) {
            defineHiddenProperty(obj, "__jsnapHiddenProp__key", nextKey);
            if (!hasPrty(obj, '__jsnapHiddenProp__key'))
                return lookupImmutableObj(obj); // immutable object; we have to use slow lookup
            nextKey += 1;
        }
        return obj.__jsnapHiddenProp__key;
    }
    
    var worklist = [];
    var heap = [];
    
    function enqueue(obj, seenFuncs) {
        if (hasPrty(obj, "__jsnapHiddenProp__visited")) {
            return;
        }
        obj.__jsnapHiddenProp__visited = true
        worklist.push([obj, seenFuncs]);
    }
    
    function dump(obj, seenFuncs) {
        var key = getKey(obj);
        if (key === null)
            return;
        var objDump = heap[key] = { properties: [] }
        var props = Object.getOwnPropertyNames(obj)
        for (var i=0; i<props.length; i++) {
            var prop = props[i];
            if (prop.substring(0,19) === '__jsnapHiddenProp__')
                continue;
            if (prop === '__proto__')
                continue;
            try {
                var desc = Object.getOwnPropertyDescriptor(obj, prop)
            } catch (e) {
                continue; // skip if WebKit security gets angry
            }
            if (!desc)
                continue; // happens to strange objects sometimes
            var descDump = {
                name: prop,
                writable: desc.writable,
                enumerable: desc.enumerable,
                configurable: desc.configurable
            }
            if (hasPrty(desc,'get')) {
                descDump.get = convertValue(desc.get, seenFuncs)
            }
            if (hasPrty(desc, 'set')) {
                descDump.set = convertValue(desc.set, seenFuncs)
            }
            if (hasPrty(desc,'value')) {
                descDump.value = convertValue(desc.value, seenFuncs)
            }
            objDump.properties.push(descDump)
        }
        if (!hasPrty(obj, '__jsnapHiddenProp__isEnv')) {
            objDump.prototype = convertValue(Object.getPrototypeOf(obj), seenFuncs);
        }
        if (hasPrty(obj, '__jsnapHiddenProp__env')) {
            if (obj.__jsnapHiddenProp__env !== window) {
                obj.__jsnapHiddenProp__env.__jsnapHiddenProp__isEnv = true;
            }
            objDump.env = convertValue(obj.__jsnapHiddenProp__env, seenFuncs);
        }
        if (hasPrty(obj, '__jsnapHiddenProp__recordedCalls')) {
            recordedCallsQueue.push(function () {
                objDump.recordedCalls = convertValue(obj.__jsnapHiddenProp__recordedCalls, seenFuncs);
            });
        }
        if (hasPrty(obj, '__jsnapHiddenProp__fun') && typeof obj.__jsnapHiddenProp__fun !== 'undefined') {
            objDump.function = convertFun(obj.__jsnapHiddenProp__fun, obj, seenFuncs);
        } else if (typeof obj === 'function') {
            objDump.function = {type:'unknown'}
        }
    }
    function convertValue(value, seenFuncs) {
        switch (typeof value) {
            case 'undefined':
                return {isUndefined:true};
            case 'null':
            case 'boolean':
            case 'number':
            case 'string':
                return value;
            case 'object':
            case 'function':
                if (value === null)
                    return null;
                enqueue(value, seenFuncs)
                var key = getKey(value)
                if (key === null)
                    return null; // not really correct, but what can you do
                return {key: key}
        }
    }
    function convertFun(fun, value, seenFuncs) {
        var createInstances = false; // This is potentially replaced by instrument.js
        var createInstanceClassFilter = false;  // This is also potentially replaced by instrument.js
        if (createInstances && fun.type == "user" || fun.type == "bind") {
            instanceCreationQueue.push(function () {
                try {
                    if (!seenFuncs) {
                        throw new Error();
                    }
                    if (!createInstanceClassFilter || value.prototype.__proto__ != Object.prototype || Object.keys(value.prototype).length > 2) {
                        if (seenFuncs.indexOf(fun.id) === -1) {
                            var newSeenFuncs = JSON.parse(JSON.stringify(seenFuncs));
                            newSeenFuncs.push(fun.id);
                            fun.instance = convertValue(new value(), newSeenFuncs);
                        }
                    }
                } catch (ignored) { }
            });
        }

        switch (fun.type) {
            case 'user':
            case 'native':
            case 'unknown':
                return fun;
            case 'bind':
                fun.target = convertValue(fun.target, seenFuncs)
                fun.arguments = fun.arguments.map(convertValue, seenFuncs)
                return fun;
        }
        throw new Error("Unknown function ID type: " + fun.type)
    }

    var instanceCreationQueue = [];
    var recordedCallsQueue = [];

    var startDump = null;

    if (startDump != null) {
        startDump(dumpHeap);
    } else {
        dumpHeap();
    }

    function dumpHeap() {
        enqueue(window, []);
        function emptyWorkList() {
            while (worklist.length > 0) {
                var objAndSeenFunc = worklist.pop();
                dump(objAndSeenFunc[0], objAndSeenFunc[1]);
            }
        }

        emptyWorkList();

        function runQueue(queue) {
            while (queue.length > 0) {
                // Removing and running the first, so we maintain FIFO.
                queue.splice(0, 1)[0]();
                emptyWorkList();
            }
        }

        runQueue(instanceCreationQueue);
        runQueue(recordedCallsQueue);
        runQueue(instanceCreationQueue);


        var output = {
            global: getKey(window),
            heap: heap
        }

        var customCallback = null;

        if (customCallback != null) {
            customCallback(output);
        } else {
            __jsnapHiddenProp__print(JSON.stringify(output));
        }
    }
    
    // if (process && process.exit) {
    //     process.exit();
    // }
    
})();