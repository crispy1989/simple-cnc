const zstreams = require('zstreams');
const GcodeLine = require('./gcode-line');
const CrispHooks = require('crisphooks');

class GcodeProcessor extends zstreams.Transform {

	/**
	 * This is the superclass for gcode processor streams.  Gcode processors can transform and analyze gcode
	 * and can be chained together.
	 *
	 * @class GcodeProcessor
	 * @constructor
	 * @param {Object} options - Any options used to configure the gcode processor.  If this is executed
	 *   in the context of an TightCNC Server, the 'tightcnc' option will provide a reference to it, and the
	 *   'job' option will provide a reference to the JobState object.
	 *   @param {String} [options.id] - Optional id to use for this processor in status reports.  Defaults
	 *     to the gcode processor name.
	 * @param {String} name - The name of this gcode processor.  Should be hardcoded in the subclass.
	 * @param {Boolean} [modifiedGcode=true] - Set to false if this processor only records gcode lines
	 *   without modifying them.  (Adding additional properties that don't affect the gcode itself doesn't
	 *   count as modification)
	 */
	constructor(options, name, modifiesGcode = true) {
		super({ objectMode: true, highWaterMark: 20 });
		this.gcodeProcessorName = name;
		this.modifiesGcode = modifiesGcode;
		this.processorOptions = options || {};
		this.processorId = options.id || name;
		this.tightcnc = options.tightcnc || null;
		this.job = options.job || null;
		this.dryRun = false; // will be set to true in the case of a "dry run" where the gcode stream isn't sent to a real controller
		this.syncWaitingForLine = null; // used to determine when the last line pushed from this processor is received by the next in the chain
		this.preprocessInputGcode = () => {
			// This function is filled in later prior to initialization
			throw new XError(XError.INTERNAL_ERROR, 'Cannot call preprocessInputGcode outside of initProcessor()');
		};
	}

	/**
	 * This method is called to append this gcode processor to the end of a gcode processor chain.  Normally,
	 * it will just push itself onto the array.  It can also ensure that prerequisite processors are appended
	 * to the chain before this one, and that extra processors (for example, to update line numbers) are
	 * appended after this one.
	 *
	 * This method is called before initProcessor(), and is called on each processor in the chain, in order.
	 *
	 * @method addToChain
	 * @param {GcodeProcessor[]} processorChain - Array of GcodeProcessor instances in the chain so far.
	 */
	addToChain(processorChain) {
		processorChain.push(this);
	}

	/**
	 * Initializes the processor stream.  This is called in order on gcode processors in a stream.  It may
	 * return a promise.  It may also call this.preprocessInputGcode() to "dry run" through all gcode
	 * being input to this processor (for example, to compute needed data from the whole file).
	 *
	 * @method initProcessor
	 */
	initProcessor() {}

	/**
	 * This method must be implemented by subclasses.  It should construct AND initialize a copy of this instance,
	 * including any data already computed by initialization.  This method will only be called after this instance
	 * is already initialized.  It is used to minimize reprocessing of data during initialization.
	 *
	 * The default implementation is just to reconstruct and reinitialize this class, which should work as
	 * long as initialization isn't doing any "heavy" work.  Essentially, if initProcessor() calls
	 * preprocessInputGcode(), then copyProcessor() should be overridden to copy the results instead of
	 * calling preprocessInputGcode again().
	 *
	 * @method copyProcessor
	 * @return {GcodeProcessor|Promise{GcodeProcessor}} - A copy of this instance, already initialized.
	 */
	async copyProcessor() {
		let c = new (this.constructor)(this.processorOptions);
		c.preprocessInputGcode = this.preprocessInputGcode;
		await c.initProcessor();
		return c;
	}

	/**
	 * This method is added by buildProcessorChain during the processor chain initialization process, so it's
	 * not a "real" class method.  It can be used only inside of initProcessor() to preprocess incoming gcode.
	 * All preprocessed gcode is run through all prior gcode processors in the chain.
	 *
	 * @method preprocessInputGcode
	 * @return {ReadableStream} - This function returns a readable object stream that outputs GcodeLine instances.
	 *   After the readable stream ends, it will also contain a property `gcodeProcessorChain` which is an array
	 *   of all of the prior processor instances in the chain that were used to preprocess data.  This property
	 *   can be used to retrieve status information from these prior gcode processors.
	 */
	//preprocessInputGcode() { ... }

	/**
	 * Override in subclass.  This method is called for each line of gcode, with a GcodeLine instance.  The line
	 * may be transformed or analyzed.  When done, return the line to be sent to the next stage.
	 *
	 * This function can also return a promise, or an array of GcodeLine's, or null (to not forward on the line).
	 *
	 * @method processGcode
	 * @param {GcodeLine} gline
	 * @return {GcodeLine|GcodeLine[]|Promise|null}
	 */
	processGcode(gline) {}

	/**
	 * Override this method to flush any cached gcode remaining.  Analog of transform stream _flush, but unlike _flush,
	 * this can be called at any time, not just when the job ends.
	 *
	 * @method flushGcode
	 * @return {GcodeLine|GcodeLine[]|Promise|null}
	*/
	flushGcode() {}

	/**
	 * Return a status object to be included in job status reports.  null to not generate a status
	 * report for this gcode processor.
	 *
	 * @method getStatus
	 * @return {Object|Null}
	 */
	getStatus() {
		return null;
	}

	// Does not represent flushed status of the processor logic itself.  Only the streams
	// buffers (this stream's write buffer the the next stream's read buffer).
	_isFlushed() {
		return !this.gcodeProcessorChain || !this.syncWaitingForLine;
	}

	/**
	 * This function returns a promise that resolves once this gcode processor's internal send buffer (NOT including
	 * anything the gcode processor itself has buffered) has been flushed.
	 *
	 * @method waitFlush
	 * @return {Promise}
	 */
	async waitFlush() {
		await new Promise((resolve, reject) => {
			if (this._isFlushed()) return resolve();
			let done = false;
			this.once('_gcpFlushed', () => {
				if (done) return;
				done = true;
				resolve();
			});
			this.once('chainerror', (err) => {
				if (done) return;
				done = true;
				reject(err);
			});
		});
	}

	pushGcode(gline) {
		if (!gline) return;
		if (Array.isArray(gline)) {
			for (let l of gline) {
				this._checkFlushedOnPush(l);
				this.push(l);
			}
		} else {
			this._checkFlushedOnPush(gline);
			this.push(gline);
		}
	}

	/**
	 * Flushes all gcode processors downstream from (and including) this one, then waits for their internal stream
	 * buffers to clear.  Note that if data is still flowing, the streams may not be flushed anymore by the time it returns.
	 * It is intended to be used from inside an async processGcode() method, where waiting this promise will
	 * automatically prevent further data from being sent downstream.
	 *
	 * @method flushDownstreamProcessorChain
	 * @return {Promise}
	 */
	async flushDownstreamProcessorChain() {
		if (!this.gcodeProcessorChain) return;
		for (let i = this.gcodeProcessorChainIdx; i < this.gcodeProcessorChain.length; i++) {
			await this.gcodeProcessorChain[i].flushGcode();
			await this.gcodeProcessorChain[i].waitFlush();
		}
	}

	_checkFlushedOnPush(gline) {
		if (!this.gcodeProcessorChain) return;
		this.syncWaitingForLine = gline; // use this property to store the most recently pushed gline, or null if it has been flushed
		// the last processor in the chain needs to be handled specially; add a hook and consider it flushed once sent by the controller
		if (this.gcodeProcessorChainIdx === this.gcodeProcessorChain.length - 1) {
			gline.hookSync('sent', () => {
				if (gline === this.syncWaitingForLine) {
					this.syncWaitingForLine = null;
					this.emit('_gcpFlushed');
				}
			});
		}
	}

	_checkFlushedOnRecv(gline) {
		if (!this.gcodeProcessorChain) return;
		if (this.gcodeProcessorChainIdx < 1) return; // no previous stream to check if first in chain
		let prevProcessor = this.gcodeProcessorChain[this.gcodeProcessorChainIdx - 1];
		if (!prevProcessor) return;
		if (prevProcessor.syncWaitingForLine === gline) {
			// previous processor's write buffer, and this processor's read buffer, have now been flushed
			prevProcessor.syncWaitingForLine = null;
			prevProcessor.emit('_gcpFlushed');
		}
	}

	_transform(chunk, encoding, cb) {
		if (!chunk) return cb();
		this._checkFlushedOnRecv(chunk);
		let r;
		try {
			r = this.processGcode(chunk);
		} catch (err) {
			cb(err);
			return;
		}
		if (r && typeof r.then === 'function') {
			r.then((r2) => {
				try {
					this.pushGcode(r2);
					cb();
				} catch (err) {
					cb(err);
				}
			}, (err) => {
				cb(err);
			});
		} else {
			try {
				this.pushGcode(r);
				cb();
			} catch (err) {
				cb(err);
			}
		}
	}

	_flush(cb) {
		let r;
		try {
			r = this.flushGcode();
		} catch (err) {
			cb(err);
			return;
		}
		if (r && typeof r.then === 'function') {
			r.then((r2) => {
				try {
					if (r2) {
						this.pushGcode(r2);
					}
					cb();
				} catch (err) {
					cb(err);
				}
			}, (err) => {
				cb(err);
			});
		} else if (r) {
			try {
				this.pushGcode(r);
				cb();
			} catch (err) {
				cb(err);
			}
		} else {
			cb();
		}
	}

}

function callLineHooks(gline) {
	if (!gline.triggerSync) return;
	gline.triggerSync('queued');
	gline.triggerSync('sent');
	gline.triggerSync('ack');
	gline.triggerSync('executing');
	gline.triggerSync('executed');
}

// filename can be either a filename, or an array of string gcode lines, or a function that, when called, returns a readable object zstream of GcodeLine's.
function makeSourceStream(filename) {
	let lineStream;

	const glineCleanup = (gline) => {
		// to remove unnecessary references and ensure these are cleaned up properly, remove all hooks from the gcode line when it's executed or errored
		gline.hookSync('executed', 1000, () => gline._hooks = {});
		gline.hookSync('error', 1000, () => gline._hooks = {});
	};

	if (Array.isArray(filename)) {
		lineStream = zstreams.fromArray(filename);
	} else if (typeof filename === 'function') {
		return filename().through((gline) => {
			glineCleanup(gline);
			return gline;
		});
	} else {
		lineStream = zstreams.fromFile(filename).pipe(new zstreams.SplitStream(/\r?\n/));
	}
	return lineStream.through((lineStr) => {
		// remove blanks
		let gline = new GcodeLine(lineStr);
		if (!gline.words.length && !gline.comment) return undefined;
		glineCleanup(gline);
		return gline;
	});
}

/**
 * Constructs and initializes a chain of gcode processors.
 *
 * @method buildProcessorChain
 * @static
 * @param {String|String[]} filename - This is either a filename of the gcode file to read, or
 *   it's an array of strings containing the gcode data (one array element per gcode line), or
 *   a function that, when called, returns a readable object stream of GcodeLine's.
 * @param {GcodeProcessor[]} processors - An array of constructed, but not initialized, gcode processor
 *   instances.  These will be added to the chain in order.  It's possible that the chain may contain
 *   additional processors not in this list if a processor's addToChain() method appends any.
 * @param {Boolean} [stringifyLines=false] - If true, the returned stream is a readable data stream containing
 *   a single stream of data.  If false, the returned stream is a readable object stream of GcodeLine objects.
 * @return {ReadableStream} - A readable stream for the output of the chain.  It's either
 *   a readable data stream or a readable object stream (of GcodeLine objects) depending
 *   on the value of the stringifyLines parameter.  The ReadableStream will also have a property
 *   `gcodeProcessorChain` that contains an array of all of the gcode processors used, and can be used
 *   to retrieve state data from processors.  This property is not available until after the 'processorChainReady'
 *   event is fired on the returned stream.
 */
function buildProcessorChain(filename, processors, stringifyLines = false) {
	// use pass through so we can return a stream immediately while doing async stuff
	let passthroughStream = new zstreams.PassThrough({ objectMode: true });

	const doBuildChain = async() => {

		let chain = [];
		let chainById = {};

		// Add each processor to the chain using its addToChain() method.  The processors may choose
		// to add additional dependencies to the chain.
		for (let processor of processors) {
			await processor.addToChain(chain);
		}

		for (let processor of chain) {
			// if multiple of the same id, later ones in the chain overwrite prior ones
			chainById[processor.processorId] = processor;
		}

		// Initialize each processor in the chain.  For each one, include a function that can be
		// called to run through all the gcode from the source and any prior processor streams.
		// This can be used to precompute any data needed by the processor.
		const _initProcessor = async (chainIdx) => {
			// create the preprocessInputGcode method for this processor
			const preprocessInputGcode = function() {
				// Use a passthrough as a placeholder so we can return a stream instead of
				// a promise that resolves to a stream.
				let passthroughStream = new zstreams.PassThrough({ objectMode: true });
				let preprocessChain = [];
				let preprocessChainById = {};
				const buildPreprocessChain = async() => {
					// This needs to construct a chain of all processors in the chain prior to this
					// one, using copyProcessor() to construct and initialize each one.
					for (let j = 0; j < chainIdx; j++) {
						let copiedProc = await chain[j].copyProcessor();
						copiedProc.gcodeProcessorChain = preprocessChain;
						copiedProc.gcodeProcessorChainById = preprocessChainById;
						copiedProc.gcodeProcessorChainIdx = j;
						copiedProc.dryRun = true;
						preprocessChain.push(copiedProc);
						preprocessChainById[copiedProc.id] = copiedProc;
					}
					let stream = makeSourceStream(filename);
					for (let gp of preprocessChain) {
						stream.pipe(gp);
						stream = gp;
					}
					stream = stream.through((gline) => {
						// call hooks on all glines passing through to ensure gcode processors relying on hooks don't break
						callLineHooks(gline);
						return gline;
					});
					stream.pipe(passthroughStream);
				};
				buildPreprocessChain()
					.catch((err) => passthroughStream.emit('error', err));
				passthroughStream.gcodeProcessorChain = preprocessChain;
				passthroughStream.gcodeProcessorChainById = preprocessChainById;
				return passthroughStream;
			};
			chain[chainIdx].preprocessInputGcode = preprocessInputGcode;
			await chain[chainIdx].initProcessor();
		};
		for (let i = 0; i < chain.length; i++) {
			chain[i].gcodeProcessorChain = chain;
			chain[i].gcodeProcessorChainById = chainById;
			chain[i].gcodeProcessorChainIdx = i;
			await _initProcessor(i);
		}

		// Construct a chain stream by piping all of the processors together
		let stream = makeSourceStream(filename);
		stream.gcodeProcessorChain = chain;
		stream.gcodeProcessorChainById = chainById;
		for (let gp of chain) {
			stream.pipe(gp);
			stream = gp;
		}

		if (stringifyLines) {
			let stringifyStream = new zstreams.ThroughStream((gline) => {
				return gline.toString() + '\n';
			}, {
				writableObjectMode: true,
				writableHighWaterMark: 3,
				readableObjectMode: false,
				readableHighWaterMark: 50
			});
			stream.pipe(stringifyStream);
			stream = stringifyStream;
			//stream = stream.throughData((gline) => {
			//	return gline.toString() + '\n';
			//});
			stream.gcodeProcessorChain = chain;
			stream.gcodeProcessorChainById = chainById;
		}

		// pipe to pass through
		stream.pipe(passthroughStream);
		return stream;
	};

	doBuildChain()
		.then((s) => {
			passthroughStream.gcodeProcessorChain = s.gcodeProcessorChain;
			passthroughStream.gcodeProcessorChainById = s.gcodeProcessorChainById;
			passthroughStream.emit('processorChainReady', s.gcodeProcessorChain, s.gcodeProcessorChainById);
		}, (err) => {
			passthroughStream.emit('error', err);
		});

	return passthroughStream;
}

module.exports = GcodeProcessor;
module.exports.buildProcessorChain = buildProcessorChain;
module.exports.callLineHooks = callLineHooks;

