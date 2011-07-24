
// -*- tab-width: 5 -*-

var http	= require("http");
var url	= require("url");
var ltx	= require("ltx");
var util	= require("util");
var autil	= require("./autil.js");		//my utilities

var NS_CLIENT		= "jabber:client";
var NS_XMPP_SASL	= "urn:ietf:params:xml:ns:xmpp-sasl";
var NS_XMPP_BIND	= "urn:ietf:params:xml:ns:xmpp-bind";
var NS_XMPP_SESSION	= "urn:ietf:params:xml:ns:xmpp-session";
var NS_DEF		= "http://jabber.org/protocol/httpbind";
var NS_STREAM		= "http://etherx.jabber.org/streams";

/*
not using HTTP-agent thing, it probably slows down the program
(by looping through all the allocated sockets to find a free socket,
instead of allocating a new one for each client especially when u r 
provided enough resources and no. of allocated sockets are too high)...
*/

var	STATE_FIRST		= 0,
	STATE_PREAUTH		= 1,
	STATE_AUTH		= 2,
	STATE_AUTHED		= 3,
	STATE_BIND		= 4,
	STATE_SESSION		= 5,
	STATE_ONLINE		= 6,
	STATE_TERM		= 7,
	STATE_TERMINATED	= 8;

//session creation request
function screquest(host, port, username, domain, resource, password, route)
{
	this.session_attributes = {
		rid		: 5292811,		//any random rid
		jid		: autil.createJID(username, domain, resource),
		password	: password
	};
	
	this.messages_sent = 0;				//message count for the time being
	
	this.currently_held_responses = 0;		//no. of requests held by bosh-server
	
	this.current_state = STATE_FIRST;
	
	this.http_options = {
		host  	: host,
		port	  	: port,
		path		: "/http-bind/",
		method  	: "POST",
		agent 	: false
	};

	this.sendHttpRequest = function(body)
	{
		var self = this;
		this.currently_held_responses++;
		autil.xmlhttprequest(this.http_options, function(err, response) {
			self.handle(err, response);
		}, body);
	}

	this.terminateWithError = function(ss)
	{
		autil.logit("ERROR", ss);
		this.terminate();
		return;
	}

	//constructor definition
	var attr = {
		content		: "text/xml; charset=utf-8",
		to			: domain,
		rid			: this.session_attributes.rid++,
		hold			: 1,
		wait			: 60,
		ver			: '1.6',
		"xml:lang"	: "en",
		"xmpp:version"	: "1.0",
		xmlns		: NS_DEF,
		"xmlns:xmpp"	: "urn:xmpp:xbosh"
	};
	if(route)
	{
		attr.route = route;
	}
	
	var body = new ltx.Element('body', attr);
	this.sendHttpRequest(body.toString());
	
	//other member functions
	this.handle = function(err, response)
	{
		++total;
		this.current_time = new Date().getTime();
		this.currently_held_responses--;
		
		// some error in sending or receiving HTTP request
		if(err)
		{
			autil.logit("ERROR", this.session_attributes.jid + "no response: " + response);
			if(this.currently_held_responses === 0 && this.current_state >= STATE_ONLINE)
			{
				total_online_clients--;
			}
			return;
		}
		
		// ltx.parse() throws exceptions if unable to parse
		try
		{
			var body = ltx.parse(response);
		}
		catch(err)
		{
			this.terminateWithError("xml parsing error");
			return;
		}
		
		// check for stream error
		var stream_error;
		if(stream_error = body.getChild("error", NS_STREAM))
		{
			autil.logit("ERROR", "stream Error: " + stream_error);
			
			/*
		 	No need to terminate as stream already closed by xmpp-server and hence bosh-server
			but to inform other asynch methods not to send messages any more change state
			*/
			this.current_state = STATE_TERM;
			
			return;
		}

		// session termination by bosh server
		if(body.attrs.type && body.attrs.type === "terminate")
		{
			if(this.current_state != STATE_TERM)
			{
				autil.logit("INFO", "Session terminated By the Server!!!" + body);
				this.current_state = STATE_TERM;
				return;
			}
		}

		if(this.current_state === STATE_FIRST)
		{
			this.current_state = STATE_PREAUTH;
			for(var i in body.attrs)
			{
				this.session_attributes[i] = body.attrs[i];
			}
		}

		if(this.current_state === STATE_PREAUTH)
		{
			var features;
			if(features = body.getChild("features", NS_STREAM))
			{
				this.startsasl(features);
				this.current_state = STATE_AUTH;
			}
			else
			{
				this.sendxml();
			}
			return;
		}

		if(this.current_state === STATE_AUTH)
		{
			if(success = body.getChild("success", NS_CLIENT))
			{
				autil.logit("DEBUG", "Authentication Success: " + this.session_attributes.jid);
				this.current_state = STATE_AUTHED;
				this.restartstream();		//restart stream
			}
			
			else if(failure = body.getChild("failure", NS_CLIENT))
			{
				this.terminateWithError("Authentication Failure " + this.session_attributes.jid + body);
			}
			
			else
			{
				this.sendxml();			//sending empty request
			}
			
			return;
		}

		if(this.current_state === STATE_AUTHED)
		{
			//stream already restarted
			var features;
			if(features = body.getChild("features", NS_STREAM))
			{
				//checking for session support from xmpp
				if(features.getChild("session", NS_XMPP_SESSION))
				{
					this.sessionsupport = true;
				}
				else
				{
					this.sessionsupport = false;
				}

				//resource binding
				if(features.getChild("bind", NS_XMPP_BIND))
				{
					this.current_state = STATE_BIND;
					this.bindresource(this.session_attributes.jid.resource);		//bind resource
				}
				else
				{
					this.terminateWithError("Resource binding not supported");
				}
			}
			else
			{
				this.sendxml();
			}
			return;
		}

		if(this.current_state === STATE_BIND)
		{
			var iq;
			if(iq = body.getChild("iq", NS_CLIENT))
			{
				if(iq.attrs.id === "bind_1" && iq.attrs.type === "result")
				{
					//resource may get extended by xmpp server
					var new_jid = iq.getChild("bind", NS_XMPP_BIND).getChild("jid", NS_XMPP_BIND).getText();
					this.session_attributes.jid.resource = new_jid.substr(new_jid.indexOf("/") + 1);
					
					if(this.sessionsupport)
					{
						var iq = new ltx.Element("iq", {to : "example.com", type : "set", id : "sess_1"});
						iq.c("session", {xmlns : NS_XMPP_SESSION});
						this.sendxml(iq);
						this.current_state = STATE_SESSION;
					}
					else
					{
						this.getonline();
					}
				}
				else
				{
					// stanza error to be handled properly
					this.terminateWithError("iq stanza error resource binding: " + iq);
				}
			}
			else
			{
				this.sendxml();
			}
			return;
		}

		if(this.current_state === STATE_SESSION)
		{
			var iq;
			if(iq = body.getChild("iq"))
			{
				if(iq.attrs.id === "sess_1" && iq.attrs.type === "result")
				{
					this.getonline();
				}
				else
				{
					this.terminateWithError("iq stanza error session establishment: " + iq);
				}
			}
			else
			{
				this.sendxml();
			}
			return;
		}

		if(this.current_state === STATE_ONLINE)
		{
			this.handleonline(body);
		}
		
		if(this.current_state === STATE_TERM)
		{
			autil.logit("INFO", "client terminating: " + this.session_attributes.jid);
			this.current_state = STATE_TERMINATED;
			return;
		}
		
		if(this.current_state === STATE_TERMINATED)
		{
			//receiving extra held response objects
			//do nothing
			return;
		}
	}

	this.getonline = function()
	{
		++total_online_clients;
		
		autil.logit("INFO", "Session Created: " + this.session_attributes.jid);
		
		this.keepsending();
		
		if(operating_mode === 2)		//normal latency-finding mode
		{
			var self = this;
			var send_in_interval = setInterval(function() {
			
				//what if previously sent message has not yet received back ???
				if(self.current_state === STATE_ONLINE)
					self.keepsending();
				else
					clearInterval(send_in_interval);
			},message_interval * 1000);
		}
		
		this.current_state = STATE_ONLINE;
	}
	
	this.handleonline = function(body)
	{
		var recieved_message = body.getChild("message", NS_CLIENT);

		//process the response
		if( recieved_message && recieved_message.attrs.from === this.session_attributes.jid.toString())
		{
			var body_text = recieved_message.getChild("body").getText();
			
			//parse sending time from message of the form "text:t:time stamp"
			var sending_time = parseInt(body_text.substr(body_text.lastIndexOf(":t:") + 3), 10);
			
			var time_difference = (this.current_time - sending_time);
			autil.logit("INFO", "Time lag: " + time_difference);
			
			if(time_difference > message_timeout)
			{
				total_errors++;
			}
			else	
			{
				summation_time_lags += time_difference;
				total_messages_received++;
			}
			
			maximum_time_lag = Math.max(maximum_time_lag, time_difference);
			
			if(operating_mode === 1)	//bombarding mode
			{
				this.keepsending();
			}
			
			else if(this.currently_held_responses < 1)	//hold value of session is '1'
			{
				this.sendxml();
			}
		}
		
		else if(this.currently_held_responses < 1)		//hold value of session is '1'
		{
			this.sendxml();
		}
		
		return;
	}
	
	this.keepsending = function()
	{
		total_messages_sent++;
		
		this.messages_sent++;
		
		autil.logit("INFO", this.session_attributes.jid + " : " + this.messages_sent);
		
		var sample = "i(" + this.session_attributes.jid + ") am just testing with nodejs"; 
		this.sendmessage(this.session_attributes.jid, this.session_attributes.jid, "chat", sample, "my clone");
		
		return;
	}
	
	this.startsasl = function(features)
	{
		var mechanisms = features.getChild("mechanisms", NS_XMPP_SASL);
		
		if(!mechanisms)
		{
			this.terminateWithError("No features-startsasl");
			return;
		}
		
		var i;
		for(i = 0; i < mechanisms.children.length; i++)
		{
			if(mechanisms.children[i].getText() === "PLAIN")
			{
				var e = new ltx.Element("auth", {xmlns : NS_XMPP_SASL, mechanism : "PLAIN"});
				e.t(this.getplain());
				
				this.sendxml(e);
				
				return;
			}
		}
		
		this.terminateWithError("Plain SASL authentication unavailable!!!")
	}
	
	this.getplain = function()
	{
		authzid = this.session_attributes.jid.username + "@" + this.session_attributes.jid.domain;
		authcid = this.session_attributes.jid.username;
		password = this.session_attributes.password;
		
		return autil.encode64(authzid + "\u0000" + authcid + "\u0000" + password);
	}
	
	this.terminate = function()
	{
		var body = new ltx.Element("body", {sid : this.session_attributes.sid,rid : this.session_attributes.rid++, type:'terminate', xmlns:NS_DEF});
		
		body.c("presence", {type : "unavailable", xmlns : NS_CLIENT});
		
		this.sendHttpRequest(body.toString());
		
		this.current_state = STATE_TERM;
		
		return;
	}
	
	this.restartstream = function()
	{
		var attr = {
			rid			: this.session_attributes.rid++,
			sid			: this.session_attributes.sid,
			"xmpp:restart"	: "true",
			to			: this.session_attributes.from,
			"xml:lang"	: "en",
			xmlns		: NS_DEF,
			"xmlns:xmpp"	: "urn:xmpp:xbosh"
		};
		
		var body = new ltx.Element("body", attr);
		this.sendHttpRequest(body.toString());
		
		return;
	}
	
	this.bindresource = function(res_name)
	{
		var resource = new ltx.Element("resource");
		resource.t(res_name);
		var bind = new ltx.Element("bind", {xmlns : NS_XMPP_BIND});
		bind.cnode(resource);
		var iq = new ltx.Element("iq", {id : "bind_1",type : "set", xmlns : NS_CLIENT});
		iq.cnode(bind);
		
		this.sendxml(iq);
		return;
	}
	
	this.sendmessage = function(to, from, type, mbody, msubject)
	{
		var message = new ltx.Element("message",{to:to, from:from, type:type, "xml:lang":"en"});
		var body = new ltx.Element("body");
		
		//appending a time stamp at the end of the each message ":t:time"
		body.t(mbody + ":t:" + new Date().getTime());
		
		var subject = new ltx.Element("subject");
		subject.t(msubject);
		message.cnode(subject);
		message.cnode(body);
		
		this.sendxml(message);
		return;
	}
	
	this.sendxml = function(ltxe)
	{
		var body = new ltx.Element("body", {sid : this.session_attributes.sid,rid : this.session_attributes.rid++,xmlns : NS_DEF, stream : this.session_attributes.stream});
		
		if(ltxe)
		{
			body.cnode(ltxe);
		}
		
		this.sendHttpRequest(body.toString());
		return;
	}
}

//main()

var	session_objects		= [],				//array of client instances
	total				= 0,					//total number of responses from the server
	total_online_clients	= 0,					//number of Established client instances at any time
	summation_time_lags		= 0,					//summation of Response Time for successful messages 
	maximum_time_lag		= 0,					//max response time
	total_messages_received	= 0,					//total number of successful messages received
	total_messages_sent		= 0,					//total number of messages sent
	total_errors			= 0,					//number of unsuccessful messages
	message_timeout		= 7000,				//threshold value of successful response time in milliseconds
	operating_mode			= 1,					//mode of operation of application
	message_interval		= 5;					//interval between two consecutive messages sent (applicable in normal mode)

//function to print statistics
function print_statistics()
{
	autil.logit("DATA", "Total_Responses_Received: " + total);
	
	autil.logit("DATA", "Total_Established_Clients: " + total_online_clients);
	
	if(total_messages_received)
	{
		autil.logit("DATA", "Mean_Time_Lag: " + Math.round(summation_time_lags / total_messages_received));
		
		autil.logit("DATA", "Max_Time_Lag: " + maximum_time_lag);
	}
	else
	{
		autil.logit("DATA", "No message received");
	}
	
	if(total_messages_sent)
	{
		autil.logit("DATA", "Total_Messages_Sent_Per_Client: " + Math.round(total_messages_sent / total_online_clients));
		
		autil.logit("DATA", "Total_Messages_Received_Per_Client: " + Math.round(total_messages_received / total_online_clients));
		
		autil.logit("DATA", "Error %: " + ((total_errors / total_messages_sent)*100).toFixed(2) + "%");
	}
	else
	{
		autil.logit("DATA", "No message sent");
	}
	
	//reinitializing parameters again	
	total = 0;
	total_messages_sent = 0;
	total_messages_received = 0;
	total_errors = 0;
	summation_time_lags = 0;
	maximum_time_lag = 0;
	
	return;
}

function start_test(options) {
	
	autil.setloglevel(options.logging_level);
	autil.logit("INFO", "number of sessions: " + options.total_sessions);

	message_timeout = options.message_timeout * 1000;
	operating_mode = options.operating_mode;
	message_interval = options.message_interval;
	
	var u = url.parse(options.end_point);
	
	for(var i = options.start; i < options.total_sessions + options.start; ++i) {
		session_objects[i] = new screquest(u.hostname, u.port, "user" + i, "example.com", "testnode", "secret", options.xmpp_route);
	}
	
	setInterval(print_statistics, options.data_interval * 1000);
	setTimeout(function(){
		process.exit();
	}, options.record_time * 60 * 1000);
}

function main() {
	var command_line_options = require('tav').set({
		end_point: {
			note: 'The BOSH service endpoint (default: http://localhost:5280/http-bind/)',
			value: "http://localhost:5280/http-bind/"
		},
		xmpp_route: {
			note: 'The route attribute to use (default: "")', 
			value: ""
		},
		total_sessions: {
			note: 'The number of sessions to open (default: 1)',
			value: 1
		},
		logging_level: {
			note: 'The Log level you want (default: INFO)',
			value: "INFO"
		},
		start: {
			note: 'which clients u want to create(default: 1)',
			value: 1
		},
		message_timeout: {
			note: 'Upper limit of time lag for messages recieved to be declared as error in seconds(default: 7)',
			value: 10
		},
		operating_mode: {
			note: 'mode in which clients operate (1.Bombarding 2.Normal mode)(default: 1)',
			value: 1
		},
		message_interval: {
			note: 'while operating in normal mode, interval between two consecutive messages from a client(default: 5)',
			value: 5
		},
		data_interval: {
			note: 'statistics logging interval in seconds(default: 60)',
			value: 60
		},
		record_time: {
			note: 'terminate the program after this time in minutes(default: 20)',
			value: 20
		}
	});
	options = command_line_options;
	start_test(options);
}

//autil.createSpareSockets(10000, "localhost",5280);	//for testing with spare sockets[conclusion: have no effect]

main();
