#!/usr/bin/env node
var fs = require('fs')
var program = require('commander')
var instrument = require('./lib/instrument')
var spawn = require('child_process').spawn
var temp = require('temp')
var phantomjs = require('phantomjs')

temp.track(); // ensure temporary files are deleted on exit

/**
 * Options:
 * - files {string[]} Names of JavaScript files to concatenate and execute
 * - stdio: standard I/O to pass to the subprocess
 * Returns a subprocess
 */
function jsnap(options) {
    var runtime = options.runtime || 'browser';

    var chunks = []

    options.files.forEach(function (file) {
        chunks.push(fs.readFileSync(file, 'utf8'))
    })
    var instrumentedCode = instrument(chunks.join('\n'), {runtime: runtime, createInstances: options.createInstances})

    var dependencies = "";
    for (var i = 0; i < options.dependencies.length; i++) {
        dependencies += fs.readFileSync(options.dependencies[i], "utf8");
    }

    instrumentedCode = dependencies + instrumentedCode;

    if (options.onlyInstrument || true) {
        console.log(instrumentedCode);
        return;
    }

    var tempFilePath;
    if (options.tmp) {
        fs.writeFileSync(options.tmp, instrumentedCode)
        tempFilePath = options.tmp;
    } else {
        var tempFile = temp.openSync('jsnap')
        fs.writeSync(tempFile.fd, instrumentedCode)    
        tempFilePath = tempFile.path;
    }

    var subproc;

    if (runtime === 'node') {
        subproc = spawn('node', [tempFilePath], {stdio: options.stdio})
    } else if (runtime === 'browser') {
        subproc = spawn(phantomjs.path, [__dirname + '/lib/jsnap.phantom.js', tempFilePath], {stdio: options.stdio})
    } else {
        throw new Error("Invalid runtime: " + runtime)
    }

    return subproc;
}
module.exports = jsnap


function main() {
    var dependencies = [];
    function collect(val) {
        dependencies.push(val);
    }

    program.version('0.1')
        .option('--runtime [node|browser]', 'Runtime environment to use (default: browser)', String, 'browser')
        .option('--createInstances', 'Create an instance of every user of bind functions using \"new\"')
        .option('--onlyInstrument', 'Prints the instrumented code, without running it')
        .option('--dependency [file]', 'Add a dependency, that is executed before the instrumented code', collect)
        .option('--tmp [FILE]', 'Use the given file as temporary')
        .parse(process.argv)

    var options = {
        runtime: program.runtime,
        tmp: program.tmp,
        stdio: ['ignore', 1, 2],
        files: program.args,
        createInstances: program.createInstances,
        onlyInstrument: program.onlyInstrument,
        dependencies: dependencies
    };
    var subproc = jsnap(options)
    if (!options.onlyInstrument) {
        subproc.on('error', function(e) {
            console.error(e);
        })
    }
}


if (require.main === module) {
    main();
}
