'use strict';

const express = require('express');
const soap = require('soap');
const fs = require('fs');
const path = require('path');
const events = require('events');
const uuidv4 = require('uuid/v4');
const xmlconvert = require('xml-js');
const expressws = require('express-ws');
const Logger = require('./utils/logdata');
const debug = require('debug')('anl:ocpp:server');

const EventEmitter = events.EventEmitter;
const REQEVTPOSTFIX = '::REQUEST';
const CBIDCONPOSTFIX = '::CONNECTED';


let ee;

ee = new EventEmitter();

// override the soap envelope to add an additional header to support soap 1.2
// NOTE: If the npm soap module used by this evolves to support 1.2 on the
// server side, this code could be removed
//

soap.Server.prototype.__envelope = soap.Server.prototype._envelope;

soap.Server.prototype._envelope = function(body, includeTimestamp){
  // var xml = ""

  let xml = this.__envelope(body, includeTimestamp);
  xml = xml.replace(' xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"', '');
  //xml = xml.replace(' xmlns:tns="urn://Ocpp/Cs/2012/06/"','');
  return xml.replace('http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope');
};
// end envelope header modifications

////////////////////////////////////
// Node-Red stuff
///////////////////////////////////

module.exports = function(RED) {

  // Create a server node for monitoring incoming soap messages
  function OCPPServerNode(config) {

    debug('Starting CS Server Node');

    RED.nodes.createNode(this, config);
    const node = this;

    node.status({fill: 'blue', shape: 'ring', text: 'Waiting...'});

    // ee = new EventEmitter();

    ee.on('error', (err) => {
      node.error('EMITTER ERROR: ' + err);
    });


    // make local copies of our configuration
    this.svcPort = config.port;
    this.svcPath15 = config.path15;
    this.svcPath16 = config.path16;
    this.svcPath16j = config.path16j;
    this.enabled15 = config.enabled15;
    this.enabled16 = config.enabled16;
    this.enabled16j = config.enabled16j;
    this.logging = config.log || false;
    this.pathlog = config.pathlog;
    this.name = config.name || 'OCPP Server Port ' + config.port;

    if (!this.enabled16 && !this.enabled15){
      node.status({fill: 'red', shape: 'dot', text: 'Disabled'});
    }

    const logger = new Logger(this, this.pathlog, this.name);
    logger.enabled = (this.logging && (typeof this.pathlog === 'string') && this.pathlog !== '');


    // read in the soap definition
    let wsdl15 = fs.readFileSync(path.join(__dirname, 'ocpp_centralsystemservice_1.5_final.wsdl'), 'utf8');
    let wsdl16 = fs.readFileSync(path.join(__dirname, 'OCPP_CentralSystemService_1.6.wsdl'), 'utf8');


    // define the default ocpp soap function for the server
    let ocppFunc = function(ocppVer, command, args, cb, headers){
      // create a unique id for each message to identify responses
      let id = uuidv4();

      // Set a timout for each event response so they do not pile up if not responded to
      let to = setTimeout(function(id){
        // node.log("kill:" + id);
        if (ee.listenerCount(id) > 0){
          let evList = ee.listeners(id);
          ee.removeListener(id, evList[0]);
        }
      }, 120 * 1000, id);

      // This makes the response async so that we pass the responsibility onto the response node
      ee.once(id, function(returnMsg){
        // console.log("send:", id);
        clearTimeout(to);
        cb(returnMsg);
      });

      // let soapSvr = (ocppVer == "1.5") ? soapServer15 : soapServer16;

      let cbi = headers.chargeBoxIdentity.$value || headers.chargeBoxIdentity || 'Unknown';


      // let action = headers.Action.$value||headers.Action
      let action = command;

      node.status({fill: 'green', shape: 'ring', text: cbi + ': ' + action });
      // Send the message out to the rest of the flow
      sendMsg(ocppVer, command, id, args, headers);

    };

    let wsdljs;
    let wsdlservice;
    let wsdlport;
    let wsdlops;
    let ocppService15 = {};
    let ocppService16 = {};

    // define our services and the functions they call.
    // Future: should be able to define this by parsing the soap xml file read in above.

    wsdljs = xmlconvert.xml2js(wsdl15, {compact: true, spaces: 4});
    wsdlservice = wsdljs['wsdl:definitions']['wsdl:service']._attributes.name;
    wsdlport = wsdljs['wsdl:definitions']['wsdl:service']['wsdl:port']._attributes.name;
    ocppService15 = {};
    ocppService15[wsdlservice] = {};
    ocppService15[wsdlservice][wsdlport] = {};

    wsdlops = wsdljs['wsdl:definitions']['wsdl:portType']['wsdl:operation'];


    wsdlops.forEach(function(op) {
      ocppService15[wsdlservice][wsdlport][op._attributes.name] = function(args, cb, headers){ ocppFunc('1.5', op._attributes.name, args, cb, headers); };
    }, this);

    wsdljs = xmlconvert.xml2js(wsdl16, {compact: true, spaces: 4});
    wsdlservice = wsdljs['wsdl:definitions']['wsdl:service']._attributes.name;
    wsdlport = wsdljs['wsdl:definitions']['wsdl:service']['wsdl:port']._attributes.name;
    ocppService16 = {};
    ocppService16[wsdlservice] = {};
    ocppService16[wsdlservice][wsdlport] = {};

    wsdlops = wsdljs['wsdl:definitions']['wsdl:portType']['wsdl:operation'];

    wsdlops.forEach(function(op) {
      ocppService16[wsdlservice][wsdlport][op._attributes.name] = function(args, cb, headers){ ocppFunc('1.6', op._attributes.name, args, cb, headers); };
    }, this);


    const expressServer = express();
    const expressWs = expressws(expressServer);

    let x = expressWs.getWss();
    // x.clients.forEach((ws) => {
    //     let eventName = ws.upgradeReq.params.cbid + REQEVTPOSTFIX;
    //     if (ee.eventNames().indexOf(eventName) != -1){
    //         console.log( `Event ${eventName} already exists`);
    //     }else {
    //         console.log( `Need to add event ${eventName}`);
    //     }
    // });
    let wsrequest;

    x.on('connection', function connection(){
      //const ip = req.connection.remoteAddress;
      //console.log(`IP Address = ${ip}`);
      /*
             console.log('im here....');
             console.log({ws});
             let upgradeReq = ws.upgradeReq;
             console.log({upgradeReq});
             let params = ws.upgradeReq.params;
             console.log({params});

             console.log(ws.upgradeReq.params.cbid);
            if (ws.upgradeReq.params && ws.upgradeReq.params.cbid){
                let eventName = ws.upgradeReq.params.cbid + REQEVTPOSTFIX;
                if (ee.eventNames().indexOf(eventName) == -1){
                    //console.log( `Need to add event ${eventName}`);
                    //ee.on(eventname, wsrequest);
                }

            }
*/
    });


    let soapServer15, soapServer16;

    // Insert middleware into the flow...
    // WHY: Because:
    //      * node-soap repeats back the incoming "Content-Type"
    //      * some OCPP implementors add an un-necessary ACTION= to the http header content-type
    //      * Only action = /<action>Resonse seems to be valid to those same vendors.
    //      * most vendors don't care about the returned content-type of action since it is depreciated
    //        for Soap 1.2
    //
    //  The following express.use middleware will intercept the http headers and remove the additional
    //  action="/<action>" from the content-type if it sees it. This had to be done with express since
    //  node-soap removes all 'request' listeners from the server, therefore making it hard to intercept
    //  the http headers via a listener. But express inserts the middleware long before node-soap gets
    //  the message.
    //
    expressServer.use(function(req, res, next){
      if (req.method == 'POST' && typeof req.headers['content-type'] !== 'undefined') {
        if (req.headers['content-type'].toLowerCase().includes('action')){
          let ctstr = req.headers['content-type'];
          let ctarr = ctstr.split(';');
          ctarr = ctarr.filter(function(ctitem){
            return !ctitem.toLowerCase().includes('action');
          });
          req.headers['content-type'] = ctarr.join(';');
        }
      }
      next();
    });


    const server = expressServer.listen(this.svcPort, function(){
      if (node.pathlog == '') node.logging = false;
      if (node.enabled15){
        soapServer15 = soap.listen(expressServer, { path: node.svcPath15, services: ocppService15, xml: wsdl15});
        soapServer15.addSoapHeader(function(methodName, args, headers){
          return addHeaders(methodName, args, headers, 1.5);
        });

        soapServer15.log = (node.logging) ? logger.log : null;
      }

      if (node.enabled16){
        soapServer16 = soap.listen(expressServer, { path: node.svcPath16, services: ocppService16, xml: wsdl16});
        soapServer16.addSoapHeader(function(methodName, args, headers){
          return addHeaders(methodName, args, headers, 1.6);
        });

        soapServer16.log = (node.logging) ? logger.log : null;
      }

      if (node.enabled16j){
        const wspath = `${node.svcPath16j}/:cbid`;
        logger.log('info', `Ready to recieve websocket requests on ${wspath}`);
        debug(`ws path = ${wspath}`);

        expressServer.ws(wspath, function(ws, req, next) {
          const CALL = 2;
          const CALLRESULT = 3;
          const CALLERROR = 4;
          const msgTypeStr = ['received', 'replied', 'error'];

          const msgType = 0;
          const msgId = 1;
          const msgAction = 2;
          const msgCallPayload = 3;
          const msgResPayload = 2;

          let reqMsgIdToCmd = {};
          let msg = {};
          msg.ocpp = {};
          msg.payload = {};
          msg.payload.data = {};

          msg.ocpp.ocppVersion = '1.6j';
          msg.ocpp.chargeBoxIdentity = req.params.cbid;

          node.status({fill: 'green', shape: 'dot', text: `Connected on ${node.svcPath16j}/${req.params.cbid}`});

          // emit to other nodes the connection has been established
          ee.emit(req.params.cbid + CBIDCONPOSTFIX);

          let eventname = req.params.cbid + REQEVTPOSTFIX;
          logger.log('info', `Websocket connecting to chargebox: ${req.params.cbid}`);


          wsrequest = (data, cb) => {
            let err;
            let request = [];

            request[msgType] = CALL;
            request[msgId] = data.payload.MessageId || uuidv4();
            request[msgAction] = data.ocpp.command;
            request[msgCallPayload] = data.ocpp.data || {};

            logger.log('request', JSON.stringify(request).replace(/,/g, ', '));

            ee.once(request[msgId], (retData) => {
              cb(err, retData);
            });

            reqMsgIdToCmd[request[msgId]] = request[msgAction];

            ws.send(JSON.stringify(request));

          };


          ee.on(eventname, wsrequest);

          ws.on('open', function() {
            //console.log('Opening a WS')
          });

          ws.on('close', function(){
            //console.log(`closing emmiter: ${eventname}, Code: ${code}, Reason ${reason}`);

            ee.removeAllListeners(eventname);
          });

          ws.on('error', function(err){
            node.log(`Websocket Error: ${err}`);
            debug(`Websocket Error: ${err}`);
          });


          let callMsgIdToCmd = [];
          let localcbid = req.params.cbid;

          debug(`Websocket connection to : ${localcbid}`);

          ws.on('message', function(msgIn){

            let response = [];

            let id = uuidv4();


            let msgParsed;

            msg.ocpp = {};
            msg.payload = {};

            const cbid = localcbid || 'unknown';

            msg.ocpp.chargeBoxIdentity = cbid;

            let eventName = cbid + REQEVTPOSTFIX;
            if (ee.eventNames().indexOf(eventName) == -1){
              debug(`Need to add event ${eventName}`);
              ee.on(eventname, wsrequest);
            }

            if (msgIn[0] != '['){
              msgParsed = JSON.parse('[' + msgIn + ']');
            } else {
              msgParsed = JSON.parse(msgIn);
            }

            logger.log(msgTypeStr[msgParsed[msgType] - CALL], msgIn);

            msg.ocpp.MessageId = msgParsed[msgId];
            msg.ocpp.msgType = msgParsed[msgType];

            debug(`Message from: ${cbid} ${msgParsed[msgAction]}`);

            if (msgParsed[msgType] == CALL){
              msg.msgId = id;
              msg.ocpp.command = msgParsed[msgAction];
              msg.payload.command = msgParsed[msgAction];
              msg.payload.data = msgParsed[msgCallPayload];

              let to = setTimeout(function(id){
                // node.log("kill:" + id);
                if (ee.listenerCount(id) > 0){
                  let evList = ee.listeners(id);
                  ee.removeListener(id, evList[0]);
                }
              }, 120 * 1000, id);


              callMsgIdToCmd.unshift({ msgId: msg.ocpp.MessageId, command: msg.ocpp.command });

              while (callMsgIdToCmd.length > 25){
                callMsgIdToCmd.pop();
              }
              // debug({callMsgIdToCmd});

              // This makes the response async so that we pass the responsibility onto the response node
              ee.once(id, function(returnMsg){
                clearTimeout(to);
                response[msgType] = CALLRESULT;
                response[msgId] = msgParsed[msgId];
                response[msgResPayload] = returnMsg;

                logger.log(msgTypeStr[response[msgType] - CALL], JSON.stringify(response).replace(/,/g, ', '));

                ws.send(JSON.stringify(response));

              });
              node.status({fill: 'green', shape: 'dot', text: `Request: ${msg.ocpp.command}`});

              node.send(msg);
            } else if (msgParsed[msgType] == CALLRESULT){
              msg.msgId = msgParsed[msgId];
              msg.payload.data = msgParsed[msgResPayload];

              // Lookup the command name via the returned message ID
              if (reqMsgIdToCmd[msg.msgId]) {
                msg.ocpp.command = reqMsgIdToCmd[msg.msgId];
                delete reqMsgIdToCmd[msg.msgId];
              } else {
                msg.ocpp.command = 'unknown';
              }
              node.status({fill: 'blue', shape: 'dot', text: `Result: ${msg.ocpp.command}`});

              ee.emit(msg.msgId, msg);

            } else if (msgParsed[msgType] == CALLERROR){

              msg.payload.ErrorCode = msgParsed[2];
              msg.payload.ErrorDescription = msgParsed[3];
              msg.payload.ErrorDetails = msgParsed[4];

              // search the command array for the command associated with the message id

              let findMsgId = { msgId: msg.ocpp.MessageId };

              let cmdIdx = callMsgIdToCmd.findIndex(getCmdIdx, findMsgId);

              if (cmdIdx != -1){
                msg.payload.command = callMsgIdToCmd[cmdIdx].command;
                msg.ocpp.command = msg.payload.command;
                delete callMsgIdToCmd.splice(cmdIdx, 1);
              } else {
                msg.payload.command = 'unknown';
                msg.ocpp.command = msg.payload.command;
              }

              node.status({fill: 'red', shape: 'dot', text: `ERROR: ${msg.payload.command}`});


              debug(`Got an ERROR: ${msg}`);


              node.send(msg);

            }

            function getCmdIdx(cmds){
              return (cmds.msgId === this.msgId);
            }

          });

          next();
        });
      }

    });

    this.on('close', function(){
      debug('About to stop the server...');
      ee.removeAllListeners();
      //console.log(expressWs.getWss());
      expressWs.getWss().clients.forEach(function(ws){
        //console.log('closing a wss');
        if (ws.readyState == 1){
          ws.close(1012, 'Restarting Server');
        }
      });
      server.close();
      this.status({fill: 'grey', shape: 'dot', text: 'stopped'});
      debug('Server closed?...');

    });

    // Creates the custom headers for our soap messages
    const addHeaders = (methodName, args, headers, ocppVer) => {
      const local_debug = false;

      if (local_debug === true){
        debug('<!--- SOAP1.6 HEADERS --->');

        debug('<!--- methodName --->');
        debug(`< ${methodName} />`);

        debug('<!--- args ---');
        debug(args);
        debug('--->');

        debug('<!--- REQUEST HEADER ----');
        debug(headers);
        debug('--->');
      }

      let addressing = 'http://www.w3.org/2005/08/addressing';
      let full_hdr;

      const mustUnderstand = (ocppVer === 1.5) ? '' : ' soap:mustUnderstand="true"';

      if (headers.Action){
        let action = headers.Action.$value || headers.Action;

        if (action){
          full_hdr = `<Action xmlns="${addressing}"${mustUnderstand}>${action}Response</Action>`;
        }
      }
      if (headers.MessageID){
        full_hdr = full_hdr + `<RelatesTo RelationshipType="http://www.w3.org/2005/08/addressing/reply" xmlns="http://www.w3.org/2005/08/addressing">${headers.MessageID}</RelatesTo>`;
      }
      full_hdr = full_hdr + `<To xmlns="${addressing}" >http://www.w3.org/2005/08/addressing/anonymous</To>`;

      if (headers.chargeBoxIdentity){
        let cb = headers.chargeBoxIdentity.$value || headers.chargeBoxIdentity;
        // We are only adding teh mustUnderstand to 1.6 since some CP implementations do not support having that
        // attribute in the chargeBoxIdentity field.
        let cbid = `<tns:chargeBoxIdentity${mustUnderstand}>${cb}</tns:chargeBoxIdentity>`;
        full_hdr = full_hdr + cbid;
      }
      if (local_debug === true){
        debug('<!--- REPLY HEADER --->');
        debug(full_hdr);
      }

      return full_hdr;

    };

    // Creates the message and payload for sending out into the flow and sends it.
    const sendMsg = function(ocppVer, command, msgId, args, headers){

      // msg {
      //  msgId
      //  ocpp {
      //      MessageId
      //      ocppVersion
      //      chargeBoxIdentity
      //      command
      //      From
      //  }
      //  payload {
      //      command
      //      data { args }
      //  }
      // }

      // NOTE: the incoming command is repeated twice in the message,
      // once for the ocpp object, and again in the payload, for convienience

      let msg = {};
      msg.ocpp = {};
      msg.payload = {};
      msg.payload.data = {};
      msg.msgId = msgId;


      msg.ocpp.command = command;
      msg.payload.command = command;

      // idenitfy which chargebox the message originated from
      msg.ocpp.chargeBoxIdentity = headers.chargeBoxIdentity.$value || headers.chargeBoxIdentity || 'Unknown';
      msg.ocpp.ocppVersion = ocppVer || 'Unknown';

      if (headers.From){
        if (headers.From.Address){
          msg.ocpp.From = headers.From.Address;
        }
      }

      // We don't use the given soap MessageID to identify our message since it may
      // be missing or repeated across messages. It is used in the return soap message however
      msg.ocpp.MessageID = headers.MessageID || 'Unknown';

      // repeat the command in the payload for convienience
      msg.payload.command = msg.ocpp.command;

      // this provide the body of the command with all the arguments
      if (args){
        msg.payload.data = args;
      }

      node.send(msg);
    };

    // function logData(type, data) {
    //   if (node.logging === true){ // only log if no errors w/ log file
    //     // set a timestamp for the logged item
    //     let date = new Date().toLocaleString();
    //     let dataStr = '<no data>';
    //     if (typeof data === 'string'){
    //       dataStr = data.replace(/[\n\r]/g, '');
    //     }
    //     // create the logged info from a template
    //     // let logInfo = `${date} \t node: ${node.name} \t type: ${type} \t data: ${data} ${os.EOL}`;
    //     let logInfo = `${date} \t node: ${node.name} \t type: ${type} \t data: ${dataStr} ${os.EOL}`;


    //     // create/append the log info to the file
    //     fs.appendFile(node.pathlog, logInfo, (err) => {
    //       if (err){
    //         node.error(`Error writing to log file: ${err}`);
    //         // If something went wrong then turn off logging
    //         node.logging = false;
    //         if (node.log) node.log = null;
    //       }
    //     });
    //   }
    // }


  }

  // Create a "resonse" node for returning messages to soap
  function OCPPResponseNode(config) {
    RED.nodes.createNode(this, config);

    let node = this;
    debug('Starting CS Response Node');

    node.status({fill: 'blue', shape: 'ring', text: 'Waiting...'});

    this.on('input', function(msg) {
      // var x = 0;
      if (msg.msgId){
        // we simply return the payload of the message and emit a node message based on the unique
        // id we created when we recieved the soap event.
        // console.log("emit msg...");
        let command = msg.ocpp.command;

        let x = ee.emit(msg.msgId, msg.payload);

        if (x){
          node.status({fill: 'green', shape: 'ring', text: command + ' sent' });
        } else {
          node.status({fill: 'red', shape: 'ring', text: 'message failed'});
        }
        // let eventname = msg.ocpp.chargeBoxIdentity + '_REQUEST';
        // console.log('sending event:', eventname);
        // var y = ee.emit(eventname, msg.ocpp.command, function(rtnData){
        //     console.log('got this back: ', rtnData);
        // });
        // if (y)
        //     console.log('got y back:', y);
        // else
        //     console.log('no y return');
      } else {
        node.log('ERROR: missing msgId for return target');
      }
    });

    this.on('close', function(removed, done){
      if (!removed){
        this.status({fill: 'grey', shape: 'dot', text: 'stopped'});
      }
      done();
    });
  }


  function OCPPChargePointServerNode(config) {

    debug('Starting CP Server Node');

    RED.nodes.createNode(this, config);
    const node = this;

    node.status({fill: 'blue', shape: 'ring', text: 'Waiting...'});

    ee.on('error', (err) => {
      node.error(`EMITTER ERROR: ${err}`);
      debug(`EMITTER ERROR: ${err}`);
    });


    // make local copies of our configuration
    this.svcPort = config.port;
    this.svcPath15 = config.path15;
    this.svcPath16 = config.path16;
    this.enabled15 = config.enabled15;
    this.enabled16 = config.enabled16;
    this.logging = config.log || false;
    this.pathlog = config.pathlog;
    this.name = config.name || 'OCPP CP Server Port ' + config.port;

    if (!this.enabled16 && !this.enabled15){
      node.status({fill: 'red', shape: 'dot', text: 'Disabled'});
    }

    const logger = new Logger(this, this.pathlog, this.name);
    logger.enabled = (this.logging && (typeof this.pathlog === 'string') && this.pathlog !== '');

    // read in the soap definition
    let wsdl15 = fs.readFileSync(path.join(__dirname, 'ocpp_chargepointservice_1.5_final.wsdl'), 'utf8');
    let wsdl16 = fs.readFileSync(path.join(__dirname, 'OCPP_ChargePointService_1.6.wsdl'), 'utf8');


    // define the default ocpp soap function for the server
    let ocppFunc = function(ocppVer, command, args, cb, headers){
      // create a unique id for each message to identify responses
      let id = uuidv4();

      // Set a timout for each event response so they do not pile up if not responded to
      let to = setTimeout(function(id){
        // node.log("kill:" + id);
        if (ee.listenerCount(id) > 0){
          let evList = ee.listeners(id);
          ee.removeListener(id, evList[0]);
        }
      }, 120 * 1000, id);

      // This makes the response async so that we pass the responsibility onto the response node
      ee.once(id, function(returnMsg){
        // console.log("send:", id);
        clearTimeout(to);
        cb(returnMsg);
      });

      // Add custom headers to the soap package


      let soapSvr = (ocppVer == '1.5') ? soapServer15 : soapServer16;

      addHeaders(headers, soapSvr);


      let cbi = headers.chargeBoxIdentity.$value || headers.chargeBoxIdentity || 'Unknown';
      // let action = headers.Action.$value||headers.Action
      let action = command;

      node.status({fill: 'green', shape: 'ring', text: cbi + ': ' + action });
      // Send the message out to the rest of the flow
      sendMsg(ocppVer, command, id, args, headers);

    };

    let wsdljs;
    let wsdlservice;
    let wsdlport;
    let wsdlops;
    let ocppService15 = {};
    let ocppService16 = {};

    // define our services and the functions they call.
    // Future: should be able to define this by parsing the soap xml file read in above.

    wsdljs = xmlconvert.xml2js(wsdl15, {compact: true, spaces: 4});
    wsdlservice = wsdljs['wsdl:definitions']['wsdl:service']._attributes.name;
    wsdlport = wsdljs['wsdl:definitions']['wsdl:service']['wsdl:port']._attributes.name;
    ocppService15 = {};
    ocppService15[wsdlservice] = {};
    ocppService15[wsdlservice][wsdlport] = {};

    wsdlops = wsdljs['wsdl:definitions']['wsdl:portType']['wsdl:operation'];

    wsdlops.forEach(function(op) {
      ocppService15[wsdlservice][wsdlport][op._attributes.name] = function(args, cb, headers){ ocppFunc('1.5', op._attributes.name, args, cb, headers); };
    }, this);

    wsdljs = xmlconvert.xml2js(wsdl16, {compact: true, spaces: 4});
    wsdlservice = wsdljs['wsdl:definitions']['wsdl:service']._attributes.name;
    wsdlport = wsdljs['wsdl:definitions']['wsdl:service']['wsdl:port']._attributes.name;
    ocppService16 = {};
    ocppService16[wsdlservice] = {};
    ocppService16[wsdlservice][wsdlport] = {};

    wsdlops = wsdljs['wsdl:definitions']['wsdl:portType']['wsdl:operation'];

    wsdlops.forEach(function(op) {
      ocppService16[wsdlservice][wsdlport][op._attributes.name] = function(args, cb, headers){ ocppFunc('1.6', op._attributes.name, args, cb, headers); };
    }, this);


    let expressServer = express();
    let soapServer15, soapServer16;

    // Insert middleware into the flow...
    // WHY: Because:
    //      * node-soap repeats back the incoming "Content-Type"
    //      * some OCPP implementors add an un-necessary ACTION= to the http header content-type
    //      * Only action = /<action>Resonse seems to be valid to those same vendors.
    //      * most vendors don't care about the returned content-type of action since it is depreciated
    //        for Soap 1.2
    //
    //  The following express.use middleware will intercept the http headers and remove the additional
    //  action="/<action>" from the content-type if it sees it. This had to be done with express since
    //  node-soap removes all 'request' listeners from the server, therefore making it hard to intercept
    //  the http headers via a listener. But express inserts the middleware long before node-soap gets
    //  the message.
    //

    expressServer.use(function(req, res, next){
      // console.log('In middleware #########')
      if (req.method == 'POST' && typeof req.headers['content-type'] !== 'undefined') {
        if (req.headers['content-type'].toLowerCase().includes('action')){
          // console.log(req.headers)
          let ctstr = req.headers['content-type'];
          let ctarr = ctstr.split(';');
          // console.log("before: ", ctarr);
          ctarr = ctarr.filter(function(ctitem){
            return !ctitem.toLowerCase().includes('action');
          });
          // console.log("after: ", ctarr.join(";"));
          req.headers['content-type'] = ctarr.join(';');
        }
      }
      next();
    });

    let server;

    try {
      server = expressServer.listen(node.svcPort, function(){
        if (node.pathlog == '') node.logging = false;

        if (node.enabled15){
          soapServer15 = soap.listen(expressServer, { path: node.svcPath15, services: ocppService15, xml: wsdl15});
          soapServer15.log = (node.logging) ? logger.log : null;
        }
        if (node.enabled16){
          soapServer16 = soap.listen(expressServer, { path: node.svcPath16, services: ocppService16, xml: wsdl16});
          soapServer16.log = (node.logging) ? logger.log : null;
        }

      });

    } catch (e) {
      console.log(`Error ${e}`);
    }

    expressServer.listen(8833, function(){
      console.log('hello');
    });

    this.on('close', function(){
      // console.log('About to stop the server...');
      ee.removeAllListeners();

      server.close();
      this.status({fill: 'grey', shape: 'dot', text: 'stopped'});
      // console.log('Server closed?...');

    });

    // Creates the custom headers for our soap messages
    const addHeaders = function(headers, soapServer){
      let addressing = 'http://www.w3.org/2005/08/addressing';
      console.log('Clearing Soap Headers 2');
      soapServer.clearSoapHeaders();
      //soapServer.addSoapHeader({'tns:chargeBoxIdentity': headers.chargeBoxIdentity });
      if (headers.Action){
        let action = headers.Action.$value || headers.Action;
        if (action){
          action = action + 'Response';
          //soapServer.addSoapHeader({Action: action }, null, null, addressing);
          let act = '<Action xmlns="' + addressing + '" soap:mustUnderstand="true">' + action + '</Action>';
          soapServer.addSoapHeader(act);
        } else {
          //node.log('ERROR: No Action Found- '+ JSON.stringify(headers));
        }

      }
      let resp = '<RelatesTo RelationshipType="http://www.w3.org/2005/08/addressing/reply" xmlns="http://www.w3.org/2005/08/addressing">' + headers.MessageID + '</RelatesTo>';
      //soapServer.addSoapHeader({ RelatesTo: headers.MessageID}, null, null, addressing)
      soapServer.addSoapHeader(resp);
      soapServer.addSoapHeader({ To: 'http://www.w3.org/2005/08/addressing/anonymous'}, null, null, addressing);
      let cbid = '<tns:chargeBoxIdentity soap:mustUnderstand="true">' + headers.chargeBoxIdentity.$value || headers.chargeBoxIdentity || 'Unknown' + '</tns:chargeBoxIdentity>';
      soapServer.addSoapHeader(cbid);
    };

    // Creates the message any payload for sending out into the flow and sends it.
    const sendMsg = function(ocppVer, command, msgId, args, headers){

      // msg {
      //  msgId
      //  ocpp {
      //      MessageId
      //      ocppVersion
      //      chargeBoxIdentity
      //      command
      //      From
      //  }
      //  payload {
      //      command
      //      data { args }
      //  }
      // }

      // NOTE: the incoming command is repeated twice in the message,
      // once for the ocpp object, and again in the payload, for convienience

      let msg = {};
      msg.ocpp = {};
      msg.payload = {};
      msg.payload.data = {};
      msg.msgId = msgId;
      msg.ee = ee;

      msg.ocpp.command = command;
      msg.payload.command = command;

      // idenitfy which chargebox the message originated from
      msg.ocpp.chargeBoxIdentity = headers.chargeBoxIdentity.$value || headers.chargeBoxIdentity || 'Unknown';
      msg.ocpp.ocppVersion = ocppVer || 'Unknown';

      if (headers.From){
        if (headers.From.Address){
          msg.ocpp.From = headers.From.Address;
        }
      }

      // We don't use the given soap MessageID to identify our message since it may
      // be missing or repeated across messages. It is used in the return soap message however
      msg.ocpp.MessageID = headers.MessageID || 'Unknown';

      // repeat the command in the payload for convienience
      msg.payload.command = msg.ocpp.command;

      // this provide the body of the command with all the arguments
      if (args){
        msg.payload.data = args;
      }

      node.send(msg);
    };

    // function logData(type, data) {
    //   if (node.logging === true){ // only log if no errors w/ log file
    //     // set a timestamp for the logged item
    //     let date = new Date().toLocaleString();
    //     let dataStr = '<no data>';
    //     if (typeof data === 'string'){
    //       dataStr = data.replace(/[\n\r]/g, '');
    //     }
    //     // create the logged info from a template
    //     // let logInfo = `${date} \t node: ${node.name} \t type: ${type} \t data: ${data} ${os.EOL}`;
    //     let logInfo = `${date} \t node: ${node.name} \t type: ${type} \t data: ${dataStr} ${os.EOL}`;


    //     // create/append the log info to the file
    //     fs.appendFile(node.pathlog, logInfo, (err) => {
    //       if (err){
    //         node.error(`Error writing to log file: ${err}`);
    //         // If something went wrong then turn off logging
    //         node.logging = false;
    //         if (node.log) node.log = null;
    //       }
    //     });
    //   }
    // }

  }

  function OCPPRequestJNode(config) {
    RED.nodes.createNode(this, config);

    debug('Starting CS request JSON Node');
    const node = this;

    this.remotecb = RED.nodes.getNode(config.remotecb);

    this.cbId = this.remotecb.cbId;
    this.name = config.name || 'Request JSON';
    this.log = config.log;
    this.pathlog = config.pathlog;
    this.cmddata = config.cmddata || 'error';
    this.command = config.command || 'error';

    let eventname = node.cbId + REQEVTPOSTFIX;


    if (ee.listenerCount(eventname) < 1) {
      node.status({fill: 'blue', shape: 'ring', text: `Waiting for ${node.cbId}`});
      ee.once(node.cbId + CBIDCONPOSTFIX, () => {
        node.status({fill: 'green', shape: 'dot', text: `Connected to ${node.cbId}`});
      });
    } else {
      node.status({fill: 'green', shape: 'dot', text: `Connected to ${node.cbId}`});
    }

    this.on('input', function(msg) {

      msg.ocpp = {};

      msg.ocpp.chargeBoxIdentity = msg.payload.cbId || node.cbId;
      eventname = msg.ocpp.chargeBoxIdentity + REQEVTPOSTFIX;

      if (ee.listenerCount(eventname) < 1) {
        node.status({fill: 'grey', shape: 'ring', text: `Not connect to ${msg.ocpp.chargeBoxIdentity}`});
        return;
      }

      msg.ocpp.command = msg.payload.command || node.command;

      // We are only validating that there is some text for the command.
      // Currently not checking for a valid command.
      if (msg.ocpp.command === 'error'){
        node.warn('OCPP JSON request node missing item: command');
        return;
      }

      // Check for the valid JSON formatted data.
      // msg.ocpp.data = msg.payload.data ||JSON.parse(node.cmddata);
      let datastr;
      if (msg.payload.data){
        try {
          datastr = JSON.stringify(msg.payload.data);
          msg.ocpp.data = JSON.parse(datastr);
        } catch (e){
          node.warn('OCPP JSON request node invalid payload.data for message (' + msg.ocpp.command + '): ' + e.message);
          return;
        }
      } else if (node.cmddata != 'error') {
        try {
          msg.ocpp.data = JSON.parse(node.cmddata);
        } catch (e){
          node.warn('OCPP JSON request node invalid message config data for message (' + msg.ocpp.command + '): ' + e.message);
          return;
        }
      } else {
        const errStr = `OCPP JSON request node missing data for message: ${msg.ocpp.command}`;
        debug(errStr);
        node.warn(errStr);
        return;
      }


      if (msg.payload.MessageId){
        msg.msgId = msg.payload.MessageId;
      }

      //console.log(ee.eventNames());

      //console.log(`${os.EOL} SENDING TO ${eventname} ${os.EOL}`)
      // console.log(JSON.stringify(msg));
      msg.payload = {};

      // console.log('About to ee.emit');
      // console.log({msg});
      node.status({fill: 'green', shape: 'dot', text: `${msg.ocpp.chargeBoxIdentity}:${msg.ocpp.command}`});
      ee.emit(eventname
        , msg, function(err, response){

          if (err) {
            // report any errors
            node.error(err);
            msg.payload = err;
            node.send(msg);
          } else {
            // put the response to the request in the message payload and send it out the flow
            //console.log(response);
            msg.ocpp = response.ocpp;
            msg.payload.data = response.payload.data;
            node.send(msg);
          }

        });

    });
  }

  RED.nodes.registerType('CS server', OCPPServerNode);
  RED.nodes.registerType('CP server SOAP', OCPPChargePointServerNode);
  RED.nodes.registerType('server response', OCPPResponseNode);
  RED.nodes.registerType('CS request JSON', OCPPRequestJNode);
};
