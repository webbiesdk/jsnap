var esprima = require('esprima')
var escodegen = require('escodegen')
var Map = require('./map.js')
var fs = require('fs')

// Returns the given AST node's immediate children as an array.
// Property names that start with $ are considered annotations, and will be ignored.
function children(node) {
    var result = [];
    for (var k in node) {
        if (!node.hasOwnProperty(k))
            continue;
        if (k[0] === '$')
            continue;
        var val = node[k];
        if (!val)
            continue;
        if (typeof val === "object" && typeof val.type === "string") {
            result.push(val);
        }
        else if (val instanceof Array) {
            for (var i=0; i<val.length; i++) {
                var elm = val[i];
                if (elm !== null && typeof elm === "object" && typeof elm.type === "string") {
                    result.push(elm);
                }
            }
        }
    }
    return result;
}

// Performs a bottom-up transform of the AST.
// Each node X is replaced by f(X). When f is called for some node, all the children of that node have already been replaced.
function fmap(node, f) {
    for (var k in node) {
        if (!node.hasOwnProperty(k))
            continue;
        if (k[0] === '$')
            continue;
        var val = node[k];
        if (!val)
            continue;
        if (typeof val === "object" && typeof val.type === "string") {
            node[k] = fmap(node[k], f);
            node[k].$parent = node;
        }
        else if (val instanceof Array) {
            for (var i=0; i<val.length; i++) {
                var elm = val[i];
                if (elm != null && typeof elm === "object" && typeof elm.type === "string") {
                    val[i] = fmap(elm, f);
                    val[i].$parent = node;
                }
            }
        }
    }
    return f(node);
}

// Assigns parent pointers to each node. The parent pointer is called $parent.
function injectParentPointers(node, parent) {
    node.$parent = parent;
    var list = children(node);
    for (var i=0; i<list.length; i++) {
        injectParentPointers(list[i], node);
    }
}

// Returns the function or program immediately enclosing the given node, possibly the node itself.
function getEnclosingFunction(node) {
    while  (node.type !== 'FunctionDeclaration' &&
    node.type !== 'FunctionExpression' &&
    node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// Returns the function, program or catch clause immediately enclosing the given node, possibly the node itself.
function getEnclosingScope(node) {
    while  (node.type !== 'FunctionDeclaration' &&
    node.type !== 'FunctionExpression' &&
    node.type !== 'CatchClause' &&
    node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// True if the given node is an Identifier in expression position.
function isIdentifierExpression(node) {
    if (node.type !== 'Identifier')
        return false;
    switch (node.$parent.type) {
        case 'FunctionExpression':
        case 'FunctionDeclaration':
        case 'CatchClause':
            return false;
        case 'VariableDeclarator':
            return node.$parent.id !== node;
        case 'MemberExpression':
            return node.$parent.computed || node.$parent.property !== node;
        case 'Property':
            return node.$parent.key !== node;
        case 'LabeledStatement':
            return node.$parent.label !== node;
        case 'BreakStatement':
        case 'ContinueStatement':
            return node.$parent.label !== node;
    }
    return true;
}

// Injects an the following into functions, programs, and catch clauses
// - $env: Map from variable names in scope to Identifier at declaration
// - $depth: nesting depth from top-level
function injectEnvs(node) {
    switch (node.type) {
        case 'Program':
            node.$env = new Map;
            node.$depth = 0;
            break;
        case 'FunctionExpression':
            node.$env = new Map;
            node.$depth = 1 + getEnclosingScope(node.$parent).$depth;
            if (node.id) {
                node.$env.put(node.id.name, node.id)
            }
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
            break;
        case 'FunctionDeclaration':
            var parent = getEnclosingFunction(node.$parent); // note: use getEnclosingFunction, because fun decls are lifted outside catch clauses
            node.$env = new Map;
            node.$depth = 1 + parent.$depth;
            parent.$env.put(node.id.name, node.id)
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
            break;
        case 'CatchClause':
            node.$env = new Map;
            node.$env.put(node.param.name, node.param)
            node.$depth = 1 + getEnclosingScope(node.$parent).$depth;
            break;
        case 'VariableDeclarator':
            var parent = getEnclosingFunction(node) // note: use getEnclosingFunction, because vars ignore catch clauses
            parent.$env.put(node.id.name, node.id)
            break;
    }
    children(node).forEach(injectEnvs)
}

// Returns the scope to which the given name resolves. Name argument is optional if the node is an Identifier.
function resolveId(node,name) {
    if (typeof name === 'undefined' && node.type === 'Identifier')
        name = node.name
    while (node.type !== 'Program') {
        if (node.$env && node.$env.has(name)) {
            return node
        }
        node = node.$parent
    }
    return node
}

// Wraps the given expression in a call to the identity function.
// This can influence the value of the this argument if x is the callee in a function call.
function wrapID(x) {
    return {
        type: 'CallExpression',
        callee: {type:'Identifier', name:'__jsnapHiddenProp__id'},
        arguments: [x]
    }
}

function wrapStmt(x) {
    return {
        type: 'ExpressionStatement',
        expression: x
    }
}

function markShadowedFunctionDecls(ast) {
    function visit(node) {
        if (node.type === 'FunctionDeclaration') {
            node.$declared_funs = new Map
            var outer = getEnclosingFunction(node.$parent)
            var existing = outer.$declared_funs.get(node.id.name)
            if (existing) {
                existing.$shadowed = true
            }
            outer.$declared_funs.put(node.id.name, node)
        }
        else if (node.type === 'Program' || node.type === 'FunctionExpression') {
            node.$declared_funs = new Map
        }
        children(node).forEach(visit)
    }
    visit(ast)
}

function prepare(ast)  {
    var id = 0;
    var callsiteId = 0;
    function visit(node) {
        switch (node.type) {
            case 'FunctionDeclaration':
            case 'FunctionExpression':
            case 'Program':
                node.$funDeclInits = [];
                node.$functionId = id++; // assign preorder IDs
                break;
            case "CallExpression":
            case "NewExpression":
                node.$callsiteId = callsiteId++;
        }
        children(node).forEach(visit);
    }
    visit(ast);
}

function ident(x) {
    return {
        type: 'Identifier',
        name: x
    }
}

function bool(boolValue) {
    return {
        "type": "Literal",
        "value": boolValue,
        "raw": boolValue + ""
    }
}

function number(number) {
    return {
        "type": "Literal",
        "value": number,
        "raw": number + ""
    }
}

function str(x) {
    return {
        "type": "Literal",
        "value": x,
        "raw": "\"" + x + "\""
    }
}

// true if the given function is a getter or a setter
function isGetterSetter(node) {
    if (node.$parent.type !== 'Property')
        return false;
    if (node.$parent.kind === 'init')
        return false;
    return true;
}

// TODO: only create necessary environments (optimization)

function transform(options) {
    return function (node) {
        var replacement = node // by default, return same object (possibly mutated)
        switch (node.type) {
            case "CallExpression":
            case "NewExpression":
                var isNew = node.type == "NewExpression";
                if (!options.recordCalls) {
                    // Do nothing.
                } else if (node.callee.type == "MemberExpression") {
                    var property;
                    if (node.callee.computed) {
                        property = node.callee.property;
                    } else {
                        property = str(node.callee.property.name);
                    }
                    replacement = {
                        "type": "CallExpression",
                        "callee": {
                            "type": "MemberExpression",
                            "computed": false,
                            "object": {
                                "type": "Identifier",
                                "name": "__jsnapHiddenProp__recordArguments_method"
                            },
                            "property": {
                                "type": "Identifier",
                                "name": "__jsnapHiddenProp__call"
                            }
                        },
                        "arguments": [
                            node.callee.object,
                            property,
                            {
                                "type": "ArrayExpression",
                                "elements": node.arguments
                            },
                            bool(isNew),
                            number(node.$callsiteId)
                        ]
                    };
                } else {
                    replacement = {
                        "type": "CallExpression",
                        "callee": {
                            "type": "MemberExpression",
                            "computed": false,
                            "object": {
                                "type": "Identifier",
                                "name": "__jsnapHiddenProp__recordArguments"
                            },
                            "property": {
                                "type": "Identifier",
                                "name": "__jsnapHiddenProp__call"
                            }
                        },
                        "arguments": [
                            {
                                "type": "ThisExpression"
                            },
                            node.callee,
                            {
                                "type": "ArrayExpression",
                                "elements": node.arguments
                            },
                            bool(isNew),
                            number(node.$callsiteId)
                        ]
                    };
                }
                break;
            case 'VariableDeclaration':
                var fun = getEnclosingFunction(node)
                if (fun.$depth > 0) {
                    var assignments = [];
                    for (var i=0; i<node.declarations.length; i++) {
                        var decl = node.declarations[i];
                        if (!decl.init)
                            continue;
                        assignments.push({
                            type:'AssignmentExpression',
                            operator:'=',
                            left: {
                                type: 'MemberExpression',
                                object: ident("__jsnapHiddenProp__env" + fun.$depth),
                                property: ident(decl.id.name)
                            },
                            right: decl.init
                        })
                    }
                    var expr = assignments.length == 1 ? assignments[0] : {type:'SequenceExpression', expressions:assignments};
                    if (node.$parent.type === 'ForStatement' && node.$parent.init === node) {
                        replacement = expr
                    } else if (node.$parent.type === 'ForInStatement' && node.$parent.left === node) {
                        replacement = {
                            type: 'MemberExpression',
                            object: ident("__jsnapHiddenProp__env" + fun.$depth),
                            property: ident(node.declarations[0].id.name)
                        }
                    } else {
                        if (assignments.length == 0) {
                            replacement = {type:'EmptyStatement'}
                        } else {
                            replacement = {type:'ExpressionStatement', expression:expr}
                        }
                    }
                }
                break;
            case 'Identifier':
                if (isIdentifierExpression(node)) {
                    var scope = resolveId(node)
                    var depth = scope.$depth
                    if (depth > 0) {
                        replacement = {
                            type:'MemberExpression',
                            object: ident('__jsnapHiddenProp__env' + depth),
                            property: ident(node.name)
                        }
                        if (node.$parent.type === 'CallExpression' && node.$parent.callee === node) {
                            replacement = wrapID(replacement) // avoid changing the this argument
                        }
                    }
                }
                break;
            case 'ObjectExpression':
                var ids = []
                var properties = {}
                for (var i=0; i<node.properties.length; i++) {
                    var prty = node.properties[i];
                    if (prty.kind === 'get' || prty.kind === 'set') {
                        var key = prty.key.type === 'Literal' ? prty.key.value : prty.key.name;
                        if (!properties[key]) {
                            properties[key] = {};
                        }
                        if (prty.kind === 'get')
                            properties[key].get = prty.value.$functionId;
                        else
                            properties[key].set = prty.value.$functionId;
                    }
                }
                for (var k in properties) {
                    var prty = properties[k]
                    if ("get" in prty)
                        ids.push(prty.get)
                    if ("set" in prty)
                        ids.push(prty.set)
                }
                if (ids.length > 0) { // only instrument if object has getters/setters
                    var scope = getEnclosingScope(node)
                    replacement = {
                        type: 'CallExpression',
                        callee: {
                            type: 'MemberExpression',
                            object: node,
                            property: ident("__jsnapHiddenProp__initObject")
                        },
                        arguments: [
                            ident("__jsnapHiddenProp__env" + scope.$depth),
                            {
                                type: 'ArrayExpression',
                                elements: ids.map(function(x) {
                                    return {type:'Literal', value:String(x)}
                                })
                            }
                        ]
                    }
                }
                break;
            case 'FunctionExpression':
            case 'FunctionDeclaration':
                var parent = getEnclosingFunction(node.$parent)
                var head = [];
                var initProperties = [{
                    type:'Property',
                    kind:'init',
                    key:ident("__jsnapHiddenProp__env"),
                    value:ident("__jsnapHiddenProp__env" + (node.$depth-1))
                }];
                head.push({
                    type:'VariableDeclaration',
                    kind:'var',
                    declarations:[{
                        type:'VariableDeclarator',
                        id: {type:'Identifier', name:'__jsnapHiddenProp__env' + node.$depth},
                        init: {
                            type:'ObjectExpression',
                            properties:initProperties.concat(node.params.map(function(param) {
                                return {
                                    type:'Property',
                                    kind:'init',
                                    key:ident(param.name),
                                    value:ident(param.name)
                                }
                            }))
                        }
                    }]
                })
                var block = node.body;
                block.body = head.concat(node.$funDeclInits, block.body);

                if (node.type === 'FunctionExpression' && !isGetterSetter(node)) {
                    replacement = {
                        type:'CallExpression',
                        callee: {
                            type:'MemberExpression',
                            object:node,
                            property:{type:'Identifier', name:"__jsnapHiddenProp__initFunction"}
                        },
                        arguments: [
                            {type:'Identifier', name:"__jsnapHiddenProp__env" + (node.$depth - 1)},
                            {type:'Literal', value:node.$functionId},
                            {type:'Literal', value: node.id && node.id.name}
                        ]
                    }
                } else if (node.type === 'FunctionDeclaration' && !node.$shadowed) {
                    parent.$funDeclInits.push(wrapStmt({
                        type:'CallExpression',
                        callee: {
                            type:'MemberExpression',
                            object: ident(node.id.name),
                            property: ident("__jsnapHiddenProp__initFunction")
                        },
                        arguments: [
                            ident("__jsnapHiddenProp__env" + (node.$depth-1)),
                            {type:'Literal', value:node.$functionId},
                            {type:'Literal', value: node.id && node.id.name}
                        ]
                    }))
                    parent.$funDeclInits.push(wrapStmt({
                        type:'AssignmentExpression',
                        operator:'=',
                        left: {
                            type: 'MemberExpression',
                            object: ident("__jsnapHiddenProp__env" + (node.$depth-1)),
                            property: ident(node.id.name)
                        },
                        right: ident(node.id.name)
                    }))
                }
                break;
            case 'CatchClause':
                var block = node.body;
                var stmt = {
                    type: 'VariableDeclaration',
                    kind: 'var',
                    declarations: [{
                        type: 'VariableDeclarator',
                        id: ident("__jsnapHiddenProp__env" + node.$depth),
                        init: {
                            type: 'ObjectExpression',
                            properties: [{
                                type: 'Property',
                                kind: 'init',
                                key: ident("__jsnapHiddenProp__env"),
                                value: ident("__jsnapHiddenProp__env" + (node.$depth - 1))
                            },{
                                type: 'Property',
                                kind: 'init',
                                key: ident(node.param.name),
                                value: ident(node.param.name)
                            }]
                        }
                    }]
                }
                block.body = [stmt].concat(block.body)
                break;
            case 'Program':
                node.body = node.$funDeclInits.concat(node.body)
                break;
        }
        return replacement;
    }
}

function clearAnnotations(node) {
    for (var k in node) {
        if (!node.hasOwnProperty(k))
            continue;
        if (k[0] === '$')
            delete node[k]
    }
    children(node).forEach(clearAnnotations);
}

function makeNativeInitializer(name) {
    var tokens = name.split('.')
    var m;
    var exp;
    if (m = tokens[0].match(/require(.*)/)) {
        exp = { type: 'CallExpression', callee: ident('require'), arguments: [{type:'Literal', value:m[1]}] }
        tokens.shift()
    } else {
        exp = ident('window')
    }
    for (var i=0; i<tokens.length; i++) {
        exp = {
            type: 'MemberExpression',
            object: exp,
            property: ident(tokens[i])
        }
    }
    return wrapStmt({
        type: 'Assignment',
        operator: '=',
        left: { type: 'MemberExpression', object:exp, property:ident('__jsnapHiddenProp__functionId') }
    })
}

function defaulty(arg, defaults) {
    var result = {}
    for (var k in defaults) {
        if (!(k in arg)) {
            result[k] = defaults[k]
        } else {
            result[k] = arg[k]
        }
    }
    return result
}

var instrument = module.exports = function(code,options) {
    options = defaulty(options, {
        silent: true,
        prelude: true,
        dump: true,
        callback: null,
        startDump: null,
        recordCalls: false,
        runtime: 'browser',
        createInstances: false,
        createInstancesClassFilter: false
    })

    // parse+transform AST
    var ast = esprima.parse(code)
    injectParentPointers(ast, null)
    injectEnvs(ast)
    prepare(ast)
    markShadowedFunctionDecls(ast)
    var newAST = fmap(ast, transform(options));
    clearAnnotations(newAST)

    var astJSON = JSON.stringify(newAST);
    // Generate code
    var instrumentedCode = escodegen.generate(newAST);

    // Generate prelude
    if (options.prelude) {
        var preludeCode = fs.readFileSync(__dirname + '/instrument.prelude.js', 'utf8')
        var natives = fs.readFileSync(__dirname + '/natives-' + options.runtime +'.txt', 'utf8')
        options.natives = natives.split(/\r?\n/).filter(function(x) { return x != '' })
        preludeCode = preludeCode.replace('%ARGS%', JSON.stringify(options))
    } else {
        var preludeCode = ''
    }


    // Generate code for dumping state
    var dumpCode = options.dump ? fs.readFileSync(__dirname + '/instrument.dump.js', 'utf8') : "";
    if (options.createInstances) {
        dumpCode = dumpCode.replace("var createInstances = false;", "var createInstances = true;")
    }
    if (options.createInstancesClassFilter) {
        dumpCode = dumpCode.replace("var createInstanceClassFilter = false;", "var createInstanceClassFilter = true;")
    }
    if (options.callback) {
        dumpCode = dumpCode.replace("var customCallback = null;", "var customCallback = window." + options.callback + ";");
    }
    if (options.startDump) {
        dumpCode = dumpCode.replace("var startDump = null;", "var startDump = window." + options.startDump + ";");
    }

    // Generate code to exit the process, if running nodejs
    var exitCode = options.runtime == 'node' ? "process.exit();" : "";

    var totalCode = preludeCode + '\n' + instrumentedCode + '\n' + dumpCode + '\n' + exitCode

    return totalCode
}

module.exports = instrument;

// Testing entry point
if (require.main === module) {
    main();
}
function main() {
    var program = require('commander')
    program.option('--no-dump', 'Do not include dump-to-console code')
    program.option('--no-prelude', 'Do not include prelude')
    program.parse(process.argv)
    var chunks = []
    for (var i=0; i<program.args.length; i++) {
        chunks.push(fs.readFileSync(program.args[i], 'utf8'))
    }
    var code = chunks.join('\n')
    console.log(instrument(code, program))
}
