import HyperHTMLElement from 'hyperhtml-element/esm'
import Popper from 'popper.js'
import timer from 'minimal-timer'
// Passed to MediaRecorder.start as `timeslice` variable.
// Smaller chunksize is nice since, in case of errors, it has almost always stored something.
// No losing 15mins of recording for one error.
const CHUNKSIZE = 500
const START_TIMEOUT = 5000
const STOP_TIMEOUT = 5000
const MAX_TRANSIENT_RESTARTS = 3
const STABLE_RECORDING_DURATION = 30000
const WORKER_TIMEOUT = 10000
const WEBM_TYPES = [
	'video/webm;codecs=vp8,opus',
	'video/webm;codecs=vp9,opus',
	'video/webm'
]
// How long is too long for worker? Let's say 10min.
const LONG_DURATION = 10 * 60 * 1000
// Finish a part before LONG_DURATION so duration repair never receives a blob
// that is too large for the worker. The margin also leaves room for the final
// MediaRecorder chunk to arrive after stop() is requested.
const AUTO_SPLIT_DURATION = LONG_DURATION - 30 * 1000

/** 
 * All in all, the mozCaptureStream is (still) very buggy.
 *
 * [1] https://bugzilla.mozilla.org/show_bug.cgi?id=966247 
 * TL;DR: playbackRate is set to 1,and changing it will not work once recording.
 *
 * https://w3c.github.io/mediacapture-fromelement/#dom-htmlmediaelement-capturestream
 * "Muting the audio on a media element does not cause the capture to produce
 * silence, nor does hiding a media element cause captured video to stop.
 * Similarly, the audio level or volume of the media element does not affect
 * the volume of captured audio."
 *
 *
 * Audio gets muted:
 * [2] https://bugzilla.mozilla.org/show_bug.cgi?id=1178751
 *
 * MediaRecorder:
 * Errors on seeking. Always.
 * Stops recording on end, if looping. Should not do that, according to spec.
 * Some of these could be problems from captureStream, too.
 *
 */

/*
 * Workflow: record -> pauses &plays -> stop -> "preparing" -> "processing" -> final
 */
export default class LiveRecorder extends HyperHTMLElement {

	static get observedAttributes() {
		return ['target']
	}

	/**
	 * Used for unmuting audio.
	 * https://bugzilla.mozilla.org/show_bug.cgi?id=1178751
	 * ^No movement in years.
	 */
	static get audioContext() {
		if (window.liveRecorder == null) {
			//log('liveRecorder nulled??????')
			window.liveRecorder = {}
		}

		if (window.liveRecorder.context == null) {
			window.liveRecorder.context = new AudioContext
		}

		return window.liveRecorder.context
	}

	created(){
		//log('hello?')
		this.targetElement = document.querySelector(`[data-liverecorder="${this.target}"]`) 
		//log(this.targetElement, this.state, this.setState, this.data)
		if (this.targetElement != null) {
			this._shadowRoot = this.attachShadow({mode: 'closed'})
			this.popper = new Popper(this.targetElement, this, {
				placement: 'bottom'
			})

			// this.data doesn't affect render.
			this.data = []
			this.audioIsConnected = false
			this.operation = null
			this.captureCleanup = null
			this.audioSource = null
			this.stopPromise = null
			this.stopPending = false
			this.handleCaptureEnd = () => this.requestStop()
			this.captureStrategy = null
			this.recordingStream = null
			this.segmentNumber = 1
			this.isSegmentedRecording = false
			this.rolloverScheduled = false
			
			this.timer = timer()
			let fullhostname = window.location.hostname.replace('www.', '');
			let hostname = fullhostname.replace('.com', '');
			let parturl = window.location.href

			var last = parturl.lastIndexOf('/');

			var result = parturl.substring(last + 1);
			if (result == '') {
				result = parturl.split("/").reverse()[1];
			}
			const timeStamp = (new Date()).toISOString().replace(/[^0-9]/g, '-').slice(0, -8)
			let bongacams = /^\D{2}.bongacams/;
			//let title = this.targetElement.src.split('/')
			let title = this.targetElement.src.split('/')
			if (hostname == "chaturbate" || hostname.match(bongacams) || hostname == "livejasmin" || hostname == "cam4" || hostname == "streamate") {
				title = result + "." + timeStamp + "." + fullhostname
			} else {
				title = timeStamp + "." + fullhostname
			}

			this.fileTitle = title

			this.render()
		}
	}

	render() {
		const {recorder, error} = this.state
		const recording = this.recordingStream != null
		const paused = recorder.state === 'paused'
		const errored = error === '' ? 'live-recorder-none' : ''
		const realError = !error.startsWith('Whoops');
		// Using handleX style because things bug out otherwise. Maybe something to do with the polyfill.
		return this.html`
			<style>
				:host(.live-recorder-none) {
					display: none !important;
				}
				:host {
					z-index: 2147483647;
					display: block;
				}
				.live-recorder {
					all: initial;
					display: block;
					font-family: "Twemoji Mozilla";
					max-width: -moz-min-content;
					max-width: min-content;
				}
				.live-recorder-hidden {
					visibility: hidden;
				}
				.live-recorder button, .live-recorder a:not(.text-link) {
					font-family: inherit;
					-moz-appearance: button;
					appearance: button;
					background-color: white;
					border: none;
					border-radius: 5px;
					padding: 0.2em 0.7em;
					margin: 5px;
					text-align: center;
					text-decoration: none;
					cursor: pointer;
					font-family: inherit;
					font-size: 100%;
					line-height: 1;
					-moz-user-select: none;
					user-select: none;
				}
				.live-recorder-close {
					margin-left: auto;
				}
				.live-recorder-none {
					display: none !important;
				}
				.live-recorder-inner {
					display: flex;
					justify-content: space-between;
					align-items: baseline;
					background: #5f5f5f;
				}
				.live-recorder-disabled {
					cursor: wait !important;
					backgound-color: #ccc !important;
				}
				.color-white {
					color: white;
				}
				.color-white a {
					color: #d4e7ff;
				}
			</style>
			<div class="live-recorder">
				<div class="live-recorder-inner">
					<button onclick=${this.handleStartStop}
						title=${!recording ? 'Record' : 'Stop'}
						type="button"
						>
						${ !recording ? '⏺️' : '⏹️' }
					</button>

					<button onclick=${this.handlePause}
						type="button"
						title=${paused ? 'Continue recording' : 'Pause recording' }
						class=${!recording ? 'live-recorder-hidden' : ''}
						>
						${paused ? '▶️' : '⏸️'}
					</button>

					<button type="button" title="Close" onclick=${this.handleClose}>
						❎
					</button>

				</div>

				<div class=${[errored, 'live-recorder-inner'].join(' ')}>
					<span class="color-white">
						${error} <a class=${"text-link" + (realError ? '' : ' live-recorder-none') } href=${this.targetElement.src} target="_blank">Open in new tab</a>
					</span>
				</div>
			</div>
		`
	}

	get defaultState() {
		return ({
			error: '',
			recorder: { 
				state: 'inactive'
			}
		})
	}

	async handleClose() {
		if (this.operation != null && !this.recordingStream) return
		this.classList.add('live-recorder-none')
		await this.requestStop()
	}

	async handleStatus() {
		//log(this.handleStatus, this.state)
		if (this.state.error !== ''){
			//log('removing.')
			this.setState({
				error: ''
			})
		}
	}

	/**
	 * TODO: fix bug:
	 * Start rec + pause spam made start rec button stuck.
	 */
	async handlePause() {
		//log('pausing!')

		try {
			// Pause and resume are glitched and don't emit events.
			switch (this.state.recorder.state) {
				case 'recording':
					this.state.recorder.pause()
					this.timer.stop()
					break

				case 'paused':
					this.targetElement.play()
					this.state.recorder.resume()
					this.timer.resume()
					break

				default:
					//log('handlepause switch defaulted. state:', this.state)
			}
		} catch(e) {
			console.error('Live Recoder: something reasonably horrible happened in handlePause:',e)
		}
		this.render()
	}

	async handleStartStop(){
		if (this.recordingStream != null) return this.requestStop()
		if (this.operation != null) return
		this.operation = 'starting'
		try {
			await this.handleStatus()
			await this.start()
		} finally {
			this.operation = null
			await this.finishPendingOperation()
		}
	}

	async requestStop() {
		if (this.recordingStream == null || this.operation === 'stopping') return
		if (this.operation != null) {
			this.stopPending = true
			return
		}
		this.operation = 'stopping'
		try {
			await this.stop()
		} finally {
			this.operation = null
		}
	}

	async start() {
		try {
			this.transientRestarts = 0
			this.pendingRecorderError = null
			this.segmentNumber = 1
			this.isSegmentedRecording = false
			await this.targetElement.play()
			const capture = createCapture(this.targetElement)
			const stream = capture.stream
			this.recordingStream = stream
			this.captureCleanup = capture.cleanup
			this.captureStrategy = capture.strategy
			for (const event of ['ended', 'emptied', 'error']) {
				this.targetElement.addEventListener(event, this.handleCaptureEnd)
			}

			if (capture.strategy === 'mozCaptureStream' && stream.getAudioTracks().length > 0) {
				try {
					const context = LiveRecorder.audioContext
					await context.resume()
					this.audioSource = context.createMediaStreamSource(stream)
					this.audioSource.connect(context.destination)
					this.audioIsConnected = true
				} catch(e) { /* recording can continue without loopback */ }
			}

			this.data = []
			const recorder = await this.startSegment(stream)
			this.timer.start()
			this.setState({ recorder })
		} catch(e) {
			await this.cleanupCapture()
			await this.error(e)
		}
	}

	async startSegment(stream, data = this.data) {
		const mimeType = getSupportedMimeType()
		const recorder = new MediaRecorder(stream, mimeType === '' ? {} : { mimeType })
		recorder.ondataavailable = e => {
			// Keep each recorder tied to its own array. A delayed final event from a
			// stopped recorder must never land in the next segment.
			if (e.data && e.data.size > 0) data.push(e.data)
			if (this.timer.elapsedTime() >= AUTO_SPLIT_DURATION) this.scheduleRollover()
		}
		recorder.onpause = log
		recorder.onresume = log
		this.stopPromise = new Promise(resolve => { recorder.onstop = resolve })
		recorder.addEventListener('stop', this.handleCaptureEnd)
		recorder.onerror = e => {
			if (data !== this.data || this.operation === 'stopping') return
			// The stop event following a recorder error belongs to this segment.
			// End events from the player must still cancel any pending restart.
			recorder.removeEventListener('stop', this.handleCaptureEnd)
			this.pendingRecorderError = e.error || recorderError('MediaRecorderError', 'Recording failed.')
			if (this.operation == null) this.finishPendingOperation()
		}
		await startRecorder(recorder, CHUNKSIZE, START_TIMEOUT)
		return recorder
	}

	async finishPendingOperation() {
		if (this.stopPending) return this.requestStop()
		const error = this.pendingRecorderError
		if (!error || !this.recordingStream) return
		this.pendingRecorderError = null
		if (this.timer.elapsedTime() >= STABLE_RECORDING_DURATION) this.transientRestarts = 0
		if (error.name === 'UnknownError' && this.transientRestarts < MAX_TRANSIENT_RESTARTS) {
			this.transientRestarts += 1
			await this.runRollover(true)
		} else {
			this.operation = 'stopping'
			try {
				await this.error(error)
			} finally {
				this.operation = null
			}
		}
	}

	scheduleRollover() {
		if (this.rolloverScheduled || this.operation != null) return
		this.rolloverScheduled = true
		Promise.resolve().then(async () => {
			if (this.operation != null || this.state.recorder.state === 'inactive') {
				this.rolloverScheduled = false
				return
			}
			this.rolloverScheduled = false
			await this.runRollover(false)
		})
	}

	async runRollover(recovering) {
		this.operation = recovering ? 'restarting' : 'rolling-over'
		try {
			await this.rollover(recovering)
		} catch(e) {
			await this.error(e)
		} finally {
			this.operation = null
			await this.finishPendingOperation()
		}
	}

	async rollover(recovering) {
		const recorder = this.state.recorder
		if (!recovering && recorder.state === 'inactive') return

		const wasPaused = !this.timer.isRunning()
		this.timer.stop()
		recorder.onerror = null
		recorder.removeEventListener('stop', this.handleCaptureEnd)
		if (recorder.state !== 'inactive') recorder.stop()
		if (this.stopPromise != null) {
			await Promise.race([this.stopPromise, delay(STOP_TIMEOUT)])
		}

		if (this.stopPending) return
		if (recovering && (this.targetElement.ended || this.targetElement.error ||
			!this.recordingStream.getTracks().some(track => track.readyState === 'live'))) {
			this.stopPending = true
			return
		}
		const completedData = this.data
		const completedDuration = this.timer.elapsedTime()
		const completedSegmentNumber = this.segmentNumber
		this.isSegmentedRecording = true
		this.data = []

		// Restart on the existing capture before processing the completed part so
		// a slow duration-repair worker does not create a gap in the recording.
		let nextRecorder
		try {
			nextRecorder = await this.startSegment(this.recordingStream)
		} catch(e) {
			// The completed part is still valid even if recording cannot continue.
			await this.save(completedData, completedDuration, completedSegmentNumber, true)
			throw e
		}
		this.segmentNumber += 1
		this.timer.start()
		if (wasPaused && nextRecorder.state === 'recording') {
			nextRecorder.pause()
			this.timer.stop()
		}
		this.setState({ recorder: nextRecorder })

		await this.save(completedData, completedDuration, completedSegmentNumber, true)
		if (completedData.length && !this.stopPending && !this.pendingRecorderError) this.setState({
			error: 'Whoops: Part ' + padSegmentNumber(completedSegmentNumber) + ' saved. Recording continues.'
		})
	}
	async error(e) {
		//log('error', e, e.name, e.message)
		let error
		if (e.name === 'SecurityError') {
			error = 'Security error: open the video in its own tab.'
		} else if (e.name && e.message) {
			//log( 'hello??', this.state, this.data )
			error = '' + e.name + ': ' + e.message
		} else {
			error = 'Undefined error. Stopped.'
		}
		await this.stop()
		//log( this.state )

		this.setState({
			error
		})
	}

	async stop() {
		const recorder = this.state.recorder
		this.timer.stop()
		if (typeof recorder.stop === 'function') {
			recorder.removeEventListener('stop', this.handleCaptureEnd)
			if (recorder.state !== 'inactive') recorder.stop()
		}
		if (this.stopPromise != null) {
			// Firefox can mark the recorder inactive before delivering its final chunk.
			await Promise.race([this.stopPromise, delay(STOP_TIMEOUT)])
		}
		await this.cleanupCapture()
		this.recordingStream = null
		this.pendingRecorderError = null
		this.stopPending = false
		this.stopPromise = null
		this.setState({ recorder: { state: 'inactive' } })
		await this.save()
	}

	async cleanupCapture() {
		for (const event of ['ended', 'emptied', 'error']) {
			this.targetElement.removeEventListener(event, this.handleCaptureEnd)
		}
		if (this.audioSource != null) {
			try { this.audioSource.disconnect() } catch(e) { /* nop */ }
			this.audioSource = null
			this.audioIsConnected = false
		}
		if (this.captureCleanup != null) {
			this.captureCleanup()
			this.captureCleanup = null
		}
		this.captureStrategy = null
	}
	/**
	 * Wire up the save button.
	 */
	async save(data = this.data, time = this.timer.elapsedTime(), segmentNumber = this.segmentNumber, segmented = this.isSegmentedRecording) {
		if (data.length === 0) {
			this.setState({ error: 'Whoops: Firefox produced no recording data.' })
			return
		}
		//log('preocessing')
		const buggyBlob = new Blob(data, { type: 'video/webm' })
		let blob = buggyBlob;
		// Send to worker, unless duration is long, which causes worker to work forever.
		if (time < LONG_DURATION) blob = await workIt(buggyBlob, time)
		// Creating the url in the worker results in CSP fiesta.
		// "Cannot load from moz-exte...."
		const downloadURL = URL.createObjectURL(blob)
		const a = document.createElement("a")
		a.download = this.fileTitle + (segmented ? '.part-' + padSegmentNumber(segmentNumber) : '') + '.webm'
		a.href = downloadURL
		document.body.appendChild(a)
		a.click()
		a.remove()
		// Firefox may consume the object URL asynchronously.
		setTimeout(() => URL.revokeObjectURL(downloadURL), 60 * 1000)
		if (data === this.data) this.data = []
		this.setState({ error: 'Whoops: Download started. Check Firefox Downloads.' })
	}
}

try{
	LiveRecorder.define('live-recorder');
} catch(e) { /* nop */ }

// eslint-disable-next-line
function log(...args) {
	// console.log('liverecorder', ...args)
}

/**
 * Messaging between worker to create a good blob.
 * Good = duration fixed.
 * Before changing this, consider that there are a lot of CSP issues.
 */
export function createCapture(mediaElement) {
	const source = mediaElement.srcObject
	if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
		const tracks = source.getTracks().filter(track => track.readyState === 'live')
		if (tracks.length === 0) throw recorderError('NotSupportedError', 'The live stream has no active media tracks.')
		return captureResult(new MediaStream(tracks.map(track => track.clone())), 'srcObject-clone', true)
	}

	const candidates = []
	if (typeof mediaElement.mozCaptureStream === 'function') candidates.push(['mozCaptureStream', mediaElement.mozCaptureStream])
	if (typeof mediaElement.captureStream === 'function') candidates.push(['captureStream', mediaElement.captureStream])
	if (candidates.length === 0) throw recorderError('NotSupportedError', 'This media element cannot be captured by Firefox.')

	let lastError
	for (const candidate of candidates) {
		try {
			const stream = candidate[1].call(mediaElement)
			if (stream && stream.getTracks().some(track => track.readyState === 'live')) return captureResult(stream, candidate[0], false)
			lastError = recorderError('NotSupportedError', candidate[0] + ' returned no active media tracks.')
		} catch(e) {
			lastError = e
		}
	}
	throw lastError
}

function captureResult(stream, strategy, ownsTracks) {
	return {
		stream,
		strategy,
		// Only stop tracks cloned by this extension. Stopping Firefox element-capture
		// tracks can propagate to the live player and interrupt playback.
		cleanup: ownsTracks ? () => stream.getTracks().forEach(track => track.stop()) : () => {}
	}
}

export function getSupportedMimeType() {
	if (typeof MediaRecorder.isTypeSupported !== 'function') return 'video/webm'
	for (const mimeType of WEBM_TYPES) {
		if (MediaRecorder.isTypeSupported(mimeType)) return mimeType
	}
	return ''
}

export function startRecorder(recorder, timeslice, timeout) {
	return new Promise((resolve, reject) => {
		const timeoutID = setTimeout(() => {
			if (recorder.state !== 'inactive') recorder.stop()
			reject(recorderError('TimeoutError', 'Firefox did not start recording within ' + timeout + ' ms.'))
		}, timeout)
		recorder.onstart = () => {
			clearTimeout(timeoutID)
			resolve()
		}
		try { recorder.start(timeslice) } catch(e) {
			clearTimeout(timeoutID)
			reject(e)
		}
	})
}

function recorderError(name, message) {
	const error = new Error(message)
	error.name = name
	return error
}
function workIt(buggyBlob, duration){
	// Fall back to the original playable WebM if duration repair stalls.
	return new Promise((resolve) => {
		const timeoutID = setTimeout(() => resolve(buggyBlob), WORKER_TIMEOUT)
		window.liveRecorder.worker.onmessage = e => {
			clearTimeout(timeoutID)
			resolve(e.data)
		}
		window.liveRecorder.worker.postMessage({buggyBlob, duration})
	})
}

function delay(duration) {
	return new Promise(resolve => setTimeout(resolve, duration))
}

function padSegmentNumber(segmentNumber) {
	return String(segmentNumber).padStart(3, '0')
}

