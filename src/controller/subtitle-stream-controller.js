/**
 * @class SubtitleStreamController
 */

import Event from '../events';
import { logger } from '../utils/logger';
import Decrypter from '../crypt/decrypter';
import { BufferHelper } from '../utils/buffer-helper';
import { findFragmentByPTS, findFragmentByPDT } from './fragment-finders';
import { FragmentState } from './fragment-tracker';
import BaseStreamController, { State } from './base-stream-controller';
import FragmentLoader from '../loader/fragment-loader';

const { performance } = window;

const TICK_INTERVAL = 500; // how often to tick in ms

export class SubtitleStreamController extends BaseStreamController {
  constructor (hls, fragmentTracker) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.MEDIA_DETACHING,
      Event.ERROR,
      Event.KEY_LOADED,
      Event.SUBTITLE_TRACKS_UPDATED,
      Event.SUBTITLE_TRACK_SWITCH,
      Event.SUBTITLE_TRACK_LOADED,
      Event.SUBTITLE_FRAG_PROCESSED);

    this.config = hls.config;
    this.currentTrackId = -1;
    this.decrypter = new Decrypter(hls, hls.config);
    this.fragCurrent = null;
    this.fragmentTracker = fragmentTracker;
    this.fragPrevious = null;
    this.media = null;
    this.state = State.STOPPED;
    this.levels = [];
    this.tracksBuffered = [];
    this.fragmentLoader = new FragmentLoader(hls.config);
  }

  onHandlerDestroyed () {
    this.fragmentTracker = null;
    this.state = State.STOPPED;
    super.onHandlerDestroyed();
  }

  onSubtitleFragProcessed (data) {
    this.state = State.IDLE;

    if (!data.success) {
      return;
    }

    const buffered = this.tracksBuffered[this.currentTrackId];
    const frag = data.frag;

    this.fragPrevious = frag;

    if (!buffered) {
      return;
    }

    // Create/update a buffered array matching the interface used by BufferHelper.bufferedInfo
    // so we can re-use the logic used to detect how much have been buffered
    // FIXME: put this in a utility function or proper object for time-ranges manipulation?
    let timeRange;
    for (let i = 0; i < buffered.length; i++) {
      if (frag.start >= buffered[i].start && frag.start <= buffered[i].end) {
        timeRange = buffered[i];
        break;
      }
    }

    if (timeRange) {
      timeRange.end = frag.start + frag.duration;
    } else {
      buffered.push({
        start: frag.start,
        end: frag.start + frag.duration
      });
    }
  }

  onMediaAttached (data) {
    this.media = data.media;
    this.state = State.IDLE;
  }

  onMediaDetaching () {
    this.media = null;
    this.state = State.STOPPED;
  }

  // If something goes wrong, procede to next frag, if we were processing one.
  onError (data) {
    let frag = data.frag;
    // don't handle error not related to subtitle fragment
    if (!frag || frag.type !== 'subtitle') {
      return;
    }
    this.state = State.IDLE;
  }

  // Got all new subtitle levels.
  onSubtitleTracksUpdated (data) {
    logger.log('subtitle levels updated');
    this.tracksBuffered = [];
    this.levels = data.subtitleTracks;
    this.levels.forEach((track) => {
      this.tracksBuffered[track.id] = [];
    });
  }

  onSubtitleTrackSwitch (data) {
    this.currentTrackId = data.id;
    if (!this.levels || this.currentTrackId === -1) {
      this.clearInterval();
      return;
    }

    // Check if track has the necessary details to load fragments
    const currentTrack = this.levels[this.currentTrackId];
    if (currentTrack && currentTrack.details) {
      this.setInterval(TICK_INTERVAL);
    }
  }

  // Got a new set of subtitle fragments.
  onSubtitleTrackLoaded (data) {
    const { id, details } = data;

    if (!this.levels) {
      logger.warn('Can not update subtitle details, no levels found');
      return;
    }

    if (this.levels[id]) {
      logger.log('Updating subtitle track details');
      this.levels[id].details = details;
    }

    this.setInterval(TICK_INTERVAL);
  }

  onKeyLoaded () {
    if (this.state === State.KEY_LOADING) {
      this.state = State.IDLE;
    }
  }

  onFragLoaded (frag, payload, stats) {
    const decryptData = frag.decryptdata;
    const hls = this.hls;

    if (this._fragLoadAborted(frag)) {
      return;
    }
    // check to see if the payload needs to be decrypted
    if (payload.byteLength > 0 && (decryptData && decryptData.key && decryptData.method === 'AES-128')) {
      let startTime = performance.now();
      // decrypt the subtitles
      this.decrypter.decrypt(payload, decryptData.key.buffer, decryptData.iv.buffer, function (decryptedData) {
        const endTime = performance.now();
        hls.trigger(Event.FRAG_DECRYPTED, {
          frag,
          payload: decryptedData,
          stats: {
            tstart: startTime,
            tdecrypt: endTime
          }
        });
      });
    }
  }

  doTick () {
    if (!this.media) {
      this.state = State.IDLE;
      return;
    }

    switch (this.state) {
    case State.IDLE:
      const levels = this.levels;
      const trackId = this.currentTrackId;

      if (!levels || !levels[trackId] || !levels[trackId].details) {
        break;
      }

      const trackDetails = levels[trackId].details;

      const config = this.config;
      const maxBufferHole = config.maxBufferHole;
      const maxConfigBuffer = Math.min(config.maxBufferLength, config.maxMaxBufferLength);
      const maxFragLookUpTolerance = config.maxFragLookUpTolerance;

      const bufferedInfo = BufferHelper.bufferedInfo(this._getBuffered(), this.media.currentTime, maxBufferHole);
      const bufferEnd = bufferedInfo.end;
      const bufferLen = bufferedInfo.len;

      const fragments = trackDetails.fragments;
      const fragLen = fragments.length;
      const end = fragments[fragLen - 1].start + fragments[fragLen - 1].duration;

      let foundFrag;
      if (bufferLen < maxConfigBuffer && bufferEnd < end) {
        foundFrag = findFragmentByPTS(this.fragPrevious, fragments, bufferEnd, maxFragLookUpTolerance);
      } else if (trackDetails.hasProgramDateTime && this.fragPrevious) {
        foundFrag = findFragmentByPDT(fragments, this.fragPrevious.endProgramDateTime, maxFragLookUpTolerance);
      }

      if (foundFrag && foundFrag.encrypted) {
        logger.log(`Loading key for ${foundFrag.sn}`);
        this.state = State.KEY_LOADING;
        this.hls.trigger(Event.KEY_LOADING, { frag: foundFrag });
      } else if (foundFrag && this.fragmentTracker.getState(foundFrag) === FragmentState.NOT_LOADED) {
        // only load if fragment is not loaded
        foundFrag.trackId = trackId; // Frags don't know their subtitle track ID, so let's just add that...
        this.fragCurrent = foundFrag;
        this._loadFragForPlayback(foundFrag);
      }
    }
  }

  _getBuffered () {
    return this.tracksBuffered[this.currentTrackId] || [];
  }
}
