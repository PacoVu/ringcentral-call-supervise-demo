require('dotenv').config()
const RingCentral = require('@ringcentral/sdk').SDK
const Subscriptions = require('@ringcentral/subscriptions').default
const fs = require('fs')
//import { nonstandard } from 'wrtc'
const { RTCAudioSink } = require('wrtc').nonstandard
const Softphone = require('ringcentral-softphone').default

const rc = new RingCentral({
  server: process.env.RINGCENTRAL_SERVER_URL,
  clientId: process.env.RINGCENTRAL_CLIENT_ID,
  clientSecret: process.env.RINGCENTRAL_CLIENT_SECRET
})

;(async () => {
  await rc.login({
    username: process.env.RINGCENTRAL_USERNAME,
    extension: process.env.RINGCENTRAL_EXTENSION,
    password: process.env.RINGCENTRAL_PASSWORD
  })
  const softphone = new Softphone(rc)
  await softphone.register()

  let audioSink
  let audioStream
  const audioPath = 'audio.raw'
  if (fs.existsSync(audioPath)) {
    fs.unlinkSync(audioPath)
  }
  softphone.on('INVITE', sipMessage => {
    softphone.answer()
    softphone.on('track', e => {
      audioSink = new RTCAudioSink(e.track)
      audioStream = fs.createWriteStream(audioPath, { flags: 'a' })
      audioSink.ondata = data => {
        console.log(`live audio data received, sample rate is ${data.sampleRate}`)
        audioStream.write(Buffer.from(data.samples.buffer))
      }
    })
  })
  softphone.on('BYE', () => {
    audioSink.stop()
    audioStream.end()
  })

  const r = await rc.get('/restapi/v1.0/account/~/extension')
  const json = await r.json()
  const agentExt = json.records.filter(ext => ext.extensionNumber === process.env.RINGCENTRAL_AGENT_EXT)[0]
  const subscriptions = new Subscriptions({
    sdk: rc
  })
  const subscription = subscriptions.createSubscription({
    pollInterval: 10 * 1000,
    renewHandicapMs: 2 * 60 * 1000
  })
  subscription.setEventFilters([`/restapi/v1.0/account/~/extension/${agentExt.id}/telephony/sessions`])
  subscription.on(subscription.events.notification, async function (message) {
    if (message.body.parties.some(p => p.status.code === 'Answered' && p.direction === 'Inbound')) {
      await rc.post(`/restapi/v1.0/account/~/telephony/sessions/${message.body.telephonySessionId}/supervise`, {
        mode: 'Listen',
        supervisorDeviceId: softphone.device.id,
        agentExtensionNumber: agentExt.extensionNumber
      })
    }
  })
  var response = await subscription.register()
  console.log(JSON.stringify(subscription.subscription()))
  /*
  subscription.register()
      .then(function(response) {
          console.log("Ready to receive telephonyStatus notification via pubnub.")
          console.log(response)
          var jsonObj = response.json();
          console.log(JSON.stringify(jsonObj))
          fs.writeFile("subscriptionId.txt", jsonObj.id, function(err) {
            if(err)
              console.log(err);
            else
              console.log("SubscriptionId " + jsonObj.id + " is saved.");
          });
      })
  */
})()
