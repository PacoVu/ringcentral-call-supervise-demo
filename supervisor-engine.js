require('dotenv').config()
const RingCentral = require('@ringcentral/sdk').SDK
const Subscriptions = require('@ringcentral/subscriptions').default
const fs = require('fs')
//import { nonstandard } from 'wrtc'
const { RTCAudioSink } = require('wrtc').nonstandard
const Softphone = require('ringcentral-softphone').default

const WatsonEngine = require('./watson.js');
var server = require('./index')


function PhoneEngine() {
  this.watson = new WatsonEngine()
  this.doRecording = false
  this.audioStream = null
  this.softphone = null
  this.deviceId = ""
  this.rc = new RingCentral({
    server: process.env.RINGCENTRAL_SERVER_URL,
    clientId: process.env.RINGCENTRAL_CLIENT_ID,
    clientSecret: process.env.RINGCENTRAL_CLIENT_SECRET
  })
  return this
}

PhoneEngine.prototype = {
  initializePhoneEngine: async function(){
    console.log("initializePhoneEngine")
    if (this.softphone)
      return
    await this.rc.login({
      username: process.env.RINGCENTRAL_USERNAME,
      extension: process.env.RINGCENTRAL_EXTENSION,
      password: process.env.RINGCENTRAL_PASSWORD
    })

    this.softphone = new Softphone(this.rc)
    try {
        await this.softphone.register()
        this.deviceId = this.softphone.device.id
        console.log("Registered deviceId: " + this.deviceId)
        server.sendPhoneEvent('online')
        let audioSink

        this.softphone.on('INVITE', sipMessage => {
          console.log("GOT INVITED")
          this.watson.createWatsonSocket("16000", (err, res) => {
            if (!err) {
              this.softphone.answer()
              server.sendPhoneEvent('connected')
              var bufferSize = 65000
              var maxFrames = 32

              this.softphone.on('track', e => {
                audioSink = new RTCAudioSink(e.track)
                //audioStream = fs.createWriteStream(audioPath, { flags: 'a' })
                var frames = 0
                var buffer = null
                audioSink.ondata = data => {
                  console.log(`live audio data received, sample rate is ${data.sampleRate}`)
                  var buf = Buffer.from(data.samples.buffer)
                  //console.log(buf.length)
                  if (buffer != null)
                      buffer = Buffer.concat([buffer, buf])
                  else
                      buffer = buf
                  frames++
                  if (frames >= maxFrames){ //68
                      //console.log("call transcribe")
                      //console.log("maxFrames: " + maxFrames)
                      console.log(`live audio data received, sample rate is ${data.sampleRate}`)
                      this.watson.transcribe(buffer)
                      buffer = Buffer.from('')
                      frames=0
                  }
                  if (this.doRecording)
                    this.audioStream.write(Buffer.from(data.samples.buffer))
                }
              })
            }
          })
      })
      this.softphone.on('BYE', () => {
          audioSink.stop()
          if (this.doRecording)
            this.audioStream.end()
          this.watson.closeConnection()
          //server.sendPhoneEvent('idle')
        })
    }catch(e){
        console.log(e)
    }
    //this.checkExistingSubscription()
    var thisClass = this
    fs.readFile('subscriptionId.txt', 'utf8', function (err, id) {
        if (err) {
          console.log("call startWebHookSubscription")
          thisClass.startWebhookSubscription()
        }else{
          console.log("subscription id: " + id)
          thisClass.checkRegisteredWebHookSubscription(id)
        }
      });
  },
  enableRecording: function(recording){
    if (recording){
      const audioPath = 'audio.raw'
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath)
      }
      this.audioStream = fs.createWriteStream(audioPath, { flags: 'a' })
      this.doRecording = true
    }else{
      this.doRecording = false
      this.audioStream.end()
    }
  },
  handleCallRecording: function (recoringState){
    console.log("recoringState: " + recoringState)
  },
  enableTranslation: function(flag) {
    if (this.watson)
      this.watson.enableTranslation(flag)
  },
  processTelephonySessionNotification: async function (body){
      console.log("ANSWER: " + JSON.stringify(body))
      console.log("deviceId: " + this.deviceId)
      try{
        var res = await this.rc.post(`/restapi/v1.0/account/~/telephony/sessions/${body.telephonySessionId}/supervise`, {
          mode: 'Listen',
          supervisorDeviceId: this.deviceId,
          agentExtensionNumber: process.env.RINGCENTRAL_AGENT_EXT //agentExt.extensionNumber
        })
      }catch(e) {
        console.log(e)
      }
  },
  startWebhookSubscription: async function() {

    var r = await this.rc.get('/restapi/v1.0/account/~/extension')
    var json = await r.json()
    const agentExt = json.records.filter(ext => ext.extensionNumber === process.env.RINGCENTRAL_AGENT_EXT)[0]

    var paramsEvent = `/restapi/v1.0/account/~/extension/${agentExt.id}/telephony/sessions`
    var eventFilters = [
          paramsEvent
        ]
    console.log("agentExt: " + agentExt.extensionNumber)
    console.log(paramsEvent)
    console.log("subscription: " + process.env.DELIVERY_MODE_ADDRESS)

    var res = await  this.rc.post('/restapi/v1.0/subscription',
            {
                eventFilters: eventFilters,
                deliveryMode: {
                    transportType: 'WebHook',
                    address: process.env.DELIVERY_MODE_ADDRESS
                }
            })
    var jsonObj = await res.json()
    console.log("Ready to telephonyStatus notification via WebHook.")
    console.log(JSON.stringify(jsonObj))
    try {
      fs.writeFile("subscriptionId.txt", jsonObj.id, function(err) {
          if(err)
              console.log(err);
          else
              console.log("SubscriptionId " + jsonObj.id + " is saved.");
      });
    }catch (e){
      console.log("WriteFile err")
    }

  },
  checkRegisteredWebHookSubscription: async function (subscriptionId) {
    try {
      let response = await this.rc.get('/restapi/v1.0/subscription')
      let json = await response.json();

      //const agentExt = json.records.filter(ext => ext.extensionNumber === process.env.RINGCENTRAL_AGENT_EXT)[0]
      if (json.records.length > 0){
        for(var record of json.records) {
          if (record.id == subscriptionId) {
            if (record.deliveryMode.transportType == "WebHook"){
              if (record.status != "Active"){
                console.log("subscription is not active. Renew it")
                await this.rc.post('/restapi/v1.0/subscription/' + record.id + "/renew")
                console.log("updated: " + record.id)
              }else {
                console.log("subscription is active. Good to go.")
                console.log("sub status: " + record.status)
              }
            }
          }
        }
      }else{
        // no existing subscription for this service. Not likely getting here
        console.log("No subscription for this service => Create one")
        this.startWebhookSubscription()
      }
    }catch(e){
      console.log("checkRegisteredWebHookSubscription ERROR")
      console.log(e)
    }
  }

}
module.exports = PhoneEngine;


/// WEBHOOK

/*

function checkRegisteredWebHookSubscription1(subscriptionId) {
    rc.get('/restapi/v1.0/subscription')
        .then(function (response) {
          var data = response.json();
          if (data.records.length > 0){
            for(var record of data.records) {
              if (record.id == subscriptionId) {
                if (record.deliveryMode.transportType == "WebHook"){
                  if (record.status != "Active"){
                    console.log("subscription is not active. Renew it")
                    platform.post('/subscription/' + record.id + "/renew")
                      .then(function (response) {
                        console.log("updated: " + record.id)
                      })
                      .catch(function(e) {
                        console.error(e);
                      });
                  }else {
                    console.log("subscription is active. Good to go.")
                    console.log("sub status: " + record.status)
                  }
                }
              }
            }
          }else{
            // no existing subscription for this service. Not likely getting here
            console.log("No subscription for this service => Create one")
            startWebhookSubscription()
          }
        })
        .catch(function(e) {
          console.error(e);
          callback(e.message, "")
        });
}

*/
