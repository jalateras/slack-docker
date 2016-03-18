'use strict';

const https = require('https');
const querystring = require('querystring');
const url = require('url');
const Promise = require('bluebird');
const JSONStream  = require('JSONStream');
const EventStream = require('event-stream');
const Dockerode = require('dockerode');
const Slack = require('slack-notify');

const StateRegExp = process.env.STATE_REGEXPR || '^(die|start|restart|stop)$';
const NameRegexp = process.env.NAME_REGEXPR || '.*';
const SlackChannel = process.env.SLACK_CHANNEL || '#devops';
const SlackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
const AwsRegion = process.env.AWS_REGION || 'UNKOWN';
const EC2Hostname = process.env.DOCKER_HOSTNAME || 'UNKOWN';
const EventHysteresis = process.env.EVENT_HYSTERESIS || 5 * 1000;

const EventInfo = {
  start: {
    pastTense: 'started',
    emoji: ':white_check_mark:',
    color: '#00FF00'
  },
  stop: {
    pastTense: 'stopped',
    emoji: ':negative_squared_cross_mark:',
    color: '#FF0000'
  },
  restart: {
    pastTense: 'restarted',
    emoji: ':recycle:',
    color: '#00FF00'
  },
  die: {
    pastTense: 'died',
    emoji: ':x:',
    color: '#FF0000'
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
        }).catch((e) => {
          event.container = {
            Name: '/UNKOWN'
          };
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
    this._notifications = {};
  }

  map(event, callback) {
    return EventStream.map((event, callback) => {
      var notification = this._notifications[event.id];
      if (!notification)  {
        notification = this._notifications[event.id] = {
          event: event
        };
      }

      if (parseInt(event.timeNano) >= parseInt(notification.event.timeNano)) {
        notification.event = event;
        if (notification.fn) {
          clearTimeout(notification.fn);
        }

        notification.fn = setTimeout(() => {
          this.sendNotification(event);
          delete this._notifications[event.id];
        }, EventHysteresis);
      }

      callback();
    });
  }

  sendNotification(event) {
    var eventInfo = EventInfo[event.status] || {};
    var status =  eventInfo.pastTense || event.status;
    var slackNotification = JSON.stringify({
      channel: SlackChannel,
      icon_emoji: eventInfo.emoji,
      username:  `${EC2Hostname}${event.container.Name} ${status}`,
      attachments: [
        {
          fallback: `${EC2Hostname}${event.container.Name} ${status}`,
          color: eventInfo.color,
          text: '',
          fields: [
            {
              title: 'Timestamp',
              value: new Date().toISOString(),
              short: true
            },
            {
              title: 'Region',
              value: AwsRegion,
              short: true
            },
            {
              title: 'Image',
              value: event.from,
              short: true
            }
          ]
        }
      ]
    });
    var postData = querystring.stringify({
      payload: slackNotification
    });
    var options = url.parse(SlackWebhookUrl);
    options.method = 'POST';
    options.headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': postData.length
    };

    var req = https.request(options)
      .on('error', function(e) {
        console.error('error', e);
      });
    req.write(postData);
    req.end();
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
