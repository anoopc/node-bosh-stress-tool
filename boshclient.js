var http=require("http");
var url=require("url");
var ltx=require("ltx");
var util=require("util");
var autil=require("./autil.js");	//my utilities

var NS_CLIENT="jabber:client";
var NS_XMPP_SASL="urn:ietf:params:xml:ns:xmpp-sasl";
var NS_XMPP_BIND="urn:ietf:params:xml:ns:xmpp-bind";
var NS_XMPP_SESSION="urn:ietf:params:xml:ns:xmpp-session";
var NS_DEF="http://jabber.org/protocol/httpbind";
var NS_STREAM="http://etherx.jabber.org/streams";

/*
removing agent thing, it probably slows down the programme
(by looping through all the allocated sockets to find a free socket,
instead of allocating a new one for each client especially when u r 
provided enough resources and no of allocated sockets are too high)...
*/

var STATE_FIRST=0,
	STATE_PREAUTH=1,
	STATE_AUTH=2,
	STATE_AUTHED=3,
	STATE_BIND=4,
	STATE_SESSION=5,
	STATE_ONLINE=6,
	STATE_TERM=7;

//session creation request 
function screquest(host,port,username,domain,resource,password,route)
{
	this.sess_attr={
		rid:5292811,
		jid:{
			username:username,
			domain:domain,
			resource:resource+autil.randomstring(),	//to avoid resource-conflict as much a possible
			toString:function(){
				return this.username+"@"+this.domain+"/"+this.resource;
			}
		},
		password:password
	};
	this.mcount=0;	//message count for the time being
	this.chold=0;
	this.state=STATE_FIRST;
	this.options={
		host : host,
		port : port,
		path : "/http-bind/",
		method : "POST",
		agent : false
	};

	this.sendhttp=function(body)
	{
		var that=this;
		this.chold++;
		autil.xmlhttprequest(this.options,function(err,response){that.handle(err,response)},body);
	}

	this.perror=function(ss)
	{
		autil.logit("ERROR",ss);
		this.terminate();
		return;
	}

	//***************constructor definition************************
	var attr={
		content:"text/xml; charset=utf-8",
		to:domain,
		rid:this.sess_attr.rid++,
		hold:1,
		wait:60,
		ver:'1.6',
		"xml:lang":"en",
		"xmpp:version":"1.0",
		xmlns:NS_DEF,
		"xmlns:xmpp":"urn:xmpp:xbosh"
	};
	if(route)
	{
		attr.route=route;
	}
	var body=new ltx.Element('body',attr);
	this.sendhttp(body.toString());
	
	//*********************other member functions**************************clean above it
	this.handle=function(err,response)
	{
		++total;
		this.t2=new Date().getTime();
		this.chold--;
		if(err)
		{
			autil.logit("ERROR",this.sess_attr.jid+"no response "+response);
			return;
		}
		try		//ltx.parse() throws exceptions if unable to parse
		{
			var body=ltx.parse(response);
		}
		catch(err)
		{
			this.perror("xml parsing ERROR");
			return;
		}
		
		// checking stream error
		var serror;
		if(serror=body.getChild("error",NS_STREAM))
		{
			autil.log("ERROR","stream Error: "+serror);
			//No need to terminate as stream already closed by xmppserver and hence bosh-server
			state=STATE_TERM;	//to inform other methods not to send messages any more
			return;
		}

		// session termination by bosh server
		if(body.attrs.type && body.attrs.type=="terminate")
		{
			if(this.state!=STATE_TERM)
			{
				autil.logit("INFO"+"Session terminated By the Server!!!"+body);				
			}
			return;
		}

		if(this.state==STATE_FIRST)
		{
			this.state=STATE_PREAUTH;
			for(var i in body.attrs)
			{
				this.sess_attr[i]=body.attrs[i];
			}
		}

		if(this.state==STATE_PREAUTH)
		{
			var features;
			if(features=body.getChild("features",NS_STREAM))
			{
				this.startsasl(features);
				this.state=STATE_AUTH;
			}
			else
			{
				this.sendxml();
			}
			return;
		}

		if(this.state==STATE_AUTH)
		{
			if(success=body.getChild("success",NS_CLIENT))
			{
				autil.logit("DEBUG","Authentication Success: "+this.sess_attr.jid);
				this.state=STATE_AUTHED;
				this.restartstream();		//restart stream
			}
			else if(failure=body.getChild("failure",NS_CLIENT))
			{
				this.perror("Authentication Failure "+this.sess_attr.jid+body);
			}
			else
			{
				this.sendxml();				//sending empty request
			}
			return;
		}

		if(this.state==STATE_AUTHED)
		{
			//stream already restarted
			var features;
			if(features=body.getChild("features",NS_STREAM))
			{
				//checking for session support from xmpp
				if(features.getChild("session",NS_XMPP_SESSION))
				{
					this.sessionsupport=true;
				}
				else
				{
					this.sessionsupport=false;
				}

				//resource binding
				if(features.getChild("bind",NS_XMPP_BIND))
				{
					this.state=STATE_BIND;
					this.bindresource(this.sess_attr.jid.resource);		//bind resource
				}
				else
				{
					this.perror("Resource binding not supported");
				}
			}
			else
			{
				this.sendxml();
			}
			return;
		}

		if(this.state==STATE_BIND)
		{
			var iq;
			if(iq=body.getChild("iq",NS_CLIENT))
			{
				if(iq.attrs.id=="bind_1" && iq.attrs.type=="result")
				{
					var cjid=iq.getChild("bind",NS_XMPP_BIND).getChild("jid",NS_XMPP_BIND).getText();
					this.sess_attr.jid.resource=cjid.substr(cjid.indexOf("/")+1);
					if(this.sessionsupport)
					{
						var iq=new ltx.Element("iq",{to:"example.com",type:"set",id:"sess_1"});
						iq.c("session",{xmlns:NS_XMPP_SESSION});
						this.sendxml(iq);
						this.state=STATE_SESSION;
					}
					else
					{
						this.getonline();
					}
				}
				else
				{
					//stanza error to be handled properly
					this.perror("iq stanza error resource binding: "+ iq);
				}
			}
			else
			{
				this.sendxml();
			}
			return;
		}

		if(this.state==STATE_SESSION)
		{
			var iq;
			if(iq=body.getChild("iq"))
			{
				if(iq.attrs.id=="sess_1" && iq.attrs.type=="result")
				{
					this.getonline();
				}
				else
				{
					this.perror("iq stanza error session establishment: "+iq);
				}
			}
			else
			{
				this.sendxml();
			}
			return;
		}

		if(this.state==STATE_ONLINE)
		{
			this.handleonline(body);
		}
		if(this.state==STATE_TERM)
		{
			autil.logit("INFO","client terminating: "+this.sess_attr.jid)
			return;
		}
	}
	this.getonline=function()
	{
		++totalclients;
		autil.logit("INFO","Session Created: "+this.sess_attr.jid);
		this.keepsending();
		if(opmode==2) 		//normal latencyfinding mode
		{
			var that=this;
			setInterval(function(){
				//what if previously sent message hasn't yet recieved back ???
				that.keepsending();
			},ninterval*1000);
		}
		this.state=STATE_ONLINE;
	}
	this.handleonline=function(body)
	{
		var mmessage;
		//check the response
		if((mmessage=body.getChild("message",NS_CLIENT)) && mmessage.attrs.from==this.sess_attr.jid)
		{
			var btext=mmessage.getChild("body").getText();
			var stime=parseInt(btext.substr(btext.lastIndexOf(":t:")+3),10);		//parsing time from the messagetext of the form "text:t:timestamp"
			var dt=(this.t2-stime);
			autil.logit("INFO","Time lag: "+dt);
			if(dt>timeout)
			{
				totalerrors++;
			}
			else	
			{
				cmean+=dt;
				totalrecieved++;
			}
			cmax=Math.max(cmax,dt);
			if(opmode==1)	//bombarding mode
			{
				this.keepsending();
			}
			else if(this.chold<1)	//hold value of session is '1'
			{
				this.sendxml();
			}
		}
		else if(this.chold<1)		//hold value of session is '1'
		{
			this.sendxml();
		}
		return;
	}
	//************************************clean below it***********************
	this.keepsending=function()
	{
		totalsent++;
		//******************sending continious messages*****************
		this.mcount++;
		autil.logit("INFO",this.sess_attr.jid+" : "+this.mcount);
		this.sendmessage(this.sess_attr.jid,this.sess_attr.jid,"chat","i("+this.sess_attr.jid+") am just testing with nodejs","my clone");
		//***************************************************************
	}
	this.startsasl=function(features)
	{
		var mechanisms=features.getChild("mechanisms",NS_XMPP_SASL);
		if(!mechanisms)
		{
			this.perror("No features-startsasl");
			return;
		}
		for(i=0;i<mechanisms.children.length;i++)
		{
			if(mechanisms.children[i].getText()=="PLAIN")
			{
				var e=new ltx.Element("auth",{xmlns:NS_XMPP_SASL,mechanism:"PLAIN"});
				e.t(this.getplain());
				this.sendxml(e);
				return;
			}
		}
		this.perror("Plain SASL authentication unavailable!!!")
	}
	this.getplain=function()
	{
		authzid=this.sess_attr.jid.username+"@"+this.sess_attr.jid.domain;
		authcid=this.sess_attr.jid.username;
		password=this.sess_attr.password;
		return autil.encode64(authzid+"\u0000"+authcid+"\u0000"+password);
	}
	this.terminate=function()
	{
		var body=new ltx.Element("body",{sid:this.sess_attr.sid,rid:this.sess_attr.rid++,type:'terminate',xmlns:NS_DEF/*,stream:this.sess_attr.stream*/});
		body.c("presence",{type:"unavailable",xmlns:NS_CLIENT});
		this.sendhttp(body.toString());
		this.state=STATE_TERM;
	}
	this.restartstream=function()
	{
		var attr={
			rid:this.sess_attr.rid++,
			sid:this.sess_attr.sid,
			"xmpp:restart":"true",
			to:this.sess_attr.from,
			"xml:lang":"en",
			xmlns:NS_DEF,
			"xmlns:xmpp":"urn:xmpp:xbosh"
		};
		var body=new ltx.Element("body",attr);
		this.sendhttp(body.toString());
	}
	this.bindresource=function(res_name)
	{
		var resource=new ltx.Element("resource");
		resource.t(res_name);
		var bind=new ltx.Element("bind",{xmlns:NS_XMPP_BIND});
		bind.cnode(resource);
		var iq=new ltx.Element("iq",{id:"bind_1",type:"set",xmlns:NS_CLIENT});
		iq.cnode(bind);
		this.sendxml(iq);
	}
	this.sendmessage=function(to,from,type,mbody,msubject)
	{
		var message=new ltx.Element("message",{to:to,from:from,type:type,"xml:lang":"en"});
		var body=new ltx.Element("body");
		body.t(mbody+":t:"+new Date().getTime());	//appending a timestamp at the end of the each message ":t:time"
		var subject=new ltx.Element("subject");
		subject.t(msubject);
		message.cnode(subject);
		message.cnode(body);
		this.sendxml(message);
	}
	this.sendxml=function(ltxe)
	{
		var body=new ltx.Element("body",{sid:this.sess_attr.sid,rid:this.sess_attr.rid++,xmlns:NS_DEF,stream:this.sess_attr.stream});
		if(ltxe)
		{
			body.cnode(ltxe);
		}
		this.sendhttp(body.toString());
	}
}

//*************************main()************************************************

var	arr=[],				//array of client instances
	total=0,				//total number of responses from the server
	totalclients=0,		//number of Established client instances at any time
	cmean=0,				//avg Response Time for successfull messages 
	cmax=0,				//max response time
	totalrecieved=0,		//total number of successfull messages recieved
	totalsent=0,			//total number of messages sent
	totalerrors=0,			//number of unsuccessfull messages
	timeout=7000,			//threshhold value of successfull response time in milliseconds
	opmode=1,				//mode of operation of application
	ninterval=5;			//while operating in normal mode, interval between two consecutive messages from a client
	
function pstatus()
{
	autil.logit("DATA","total:"+total+" nEstablished:"+totalclients);
	if(totalrecieved)
		autil.logit("DATA","meanTL:"+Math.round(cmean/totalrecieved)+" maxTL:"+cmax);
	else
		autil.logit("DATA","No message recieved");
	if(totalsent)
		autil.logit("DATA","sentperclient:"+Math.round(totalsent/totalclients)+" recievedperclient:"+Math.round(totalrecieved/totalclients)+" Error%:"+((totalerrors/totalsent)*100).toFixed(2)+"%");
	else
		autil.logit("DATA","No message sent");
	total=0;	
	totalsent=0;
	totalrecieved=0;
	totalerrors=0;
	cmean=0;
	cmax=0;
}

function start_test(options) {
	timeout=options.timeout*1000;
	opmode=options.mode;
	ninterval=options.interval;
	var u = url.parse(options.endpoint);
	autil.setloglevel(options.logging);
	autil.logit("INFO","number of sessions: "+options.nsess);
	for(var i=options.start; i<options.nsess+options.start; ++i) {
		arr[i]=new screquest(u.hostname,u.port,"user"+i,"directi.com","testnode","qwedsa",options.route);
	}
	setInterval(pstatus,options.datainterval*1000);		//printing programme status every 1 minute by default
	setTimeout(function(){
		process.exit();
	},options.terminate*60*1000);					//Terminate programme after 20 minutes by default

}
function main() {
	var opts = require('tav').set({
		endpoint: {
			note: 'The BOSH service endpoint (default: http://localhost:5280/http-bind/)',
			value: "http://localhost:5280/http-bind/"
		},
		route: {
			note: 'The route attribute to use (default: <empty>)', 
			value: ""
		},
		nsess: {
			note: 'The number of sessions to open (default: 1)',
			value: 1
		},
		logging: {
			note: 'The Loglevel you want (default: INFO)',
			value: "INFO"
		},
		start: {
			note: 'who are the clients u want to create(default: 1)',
			value: 1
		},
		timeout: {
			note: 'Upper limit of response time in seconds(default: 7)',
			value: 7
		},
		mode: {
			note: 'mode in which clients operate (1.Bombarding 2.Normal mode)(default: 1)',
			value: 1
		},
		interval: {
			note: 'while operating in normal mode, interval between two consecutive messages from a client(default: 5)',
			value: 5
		},
		datainterval: {
			note: 'statistics logging interval in seconds(default: 60)',
			value: 60
		},
		terminate: {
			note: 'terminate the programme after this time in minutes(default: 20)',
			value: 20
		}
	});
	options = opts;
	start_test(options);
}
//autil.createSpareSockets(10000,"localhost",5279);	//for testing with spare sockets
main();
