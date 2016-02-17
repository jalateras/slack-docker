"use strict";

const Promise = require('bluebird');
const JSONStream  = require('JSONStream');
const EventStream = require('event-stream');
const Dockerode = require('dockerode');
const Slack = require('slack-notify');

const StateRegExp = process.env.STATE_REGEXPR || '^(die|start)$';
const NameRegexp = process.env.NAME_REGEXPR || '.*';
const SlackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
const AwsRegion = process.env.AWS_REGION || 'UNKOWN';
const EC2Hostname = process.env.DOCKER_HOSTNAME || 'UNKOWN';

const EventInfo = {
  die: {
    pastTense: 'died',
    emoji: ':warning:',
    color: '#FF0000'
  },
  start: {
    pastTense: 'started',
    emoji: ':trophy:',
    color: '#00FF000'
  }
};

class EventStateFilter {
  constructor(regexp) {
    this._regexp = new RegExp(regexp);
  }
  filter() {
    return EventStream.map((event, callback) => {
      if (this._regexp.test(event.status)) {
        callback(null, event);
      } else {
        callback();
      }
    });
  }
}

class EventContainerNameFilter {
  constructor(regexp) {
    this._regexp = new RegExp(regexp);
  }
  filter() {
    return EventStream.map((event, callback) => {
      if (this._regexp.test(event.container.Name)) {
        callback(null, event);
      } else {
        callback();
      }
    });
  }
}

class EventInspector {
  constructor(docker) {
    this._docker = docker;
    this._containers = {};
  }
  map() {
    return EventStream.map((event, callback) => {
      if (this._containers[event.id]) {
        event.container = this._containers[event.id];
        callback(null, event);
      } else {
        Promise.promisifyAll(this._docker.getContainer(event.id))
        .inspectAsync()
        .then((container) => {
          event.container = this._containers[event.id] = container;
          callback(null, event);
        });
      }
      if (event.status == 'destroy') {
        delete this._containers[event.id];
      }
    });
  }
}
class EventNotifier {
  constructor(slack) {
    this._slack = slack;
  }

  map(event, callback) {
    return EventStream.map((event, callback) => {
      this.sendNotification(event)
        .then((sent) => callback(null, sent));
    });
  }

  sendNotification(event) {
    var eventInfo = EventInfo[event.status] || {};
    var status =  eventInfo.pastTense || event.status;

    return this._slack.sendAsync({
      username: `[${EC2Hostname}] docker${event.container.Name} container ${status.toUpperCase()}`,
      icon_emoji: eventInfo.emoji,
      channel: '',
      text: '',
      fields: {
        'Timestamp': new Date().toISOString(),
        'Region': AwsRegion.toUpperCase(),
        'Container': `docker${event.container.Name}`,
        'Image': event.from
      }
    });
  }
}

const docker = Promise.promisifyAll(new Dockerode());
const slack  = Promise.promisifyAll(Slack(SlackWebhookUrl));

docker.versionAsync()
.then((version) => console.info(version))
.then(() => docker.getEventsAsync())
.then((stream) => stream
  .pipe(JSONStream.parse())
  .pipe(new EventStateFilter(StateRegExp).filter())
  .pipe(new EventInspector(docker).map())
  .pipe(new EventContainerNameFilter(NameRegexp).filter())
  .pipe(new EventNotifier(slack).map())
).catch((e) => console.error(e));
