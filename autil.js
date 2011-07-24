
// -*- tab-width: 5 -*-

var http = require("http");
var net = require("net");

exports.decode64 = function(encoded)
{
	return (new Buffer(encoded, 'base64')).toString('utf8');
}

exports.encode64 = function(decoded)
{
	return (new Buffer(decoded, 'utf8')).toString('base64');
}

function createJID(username, domain, resource)
{
		
	return {
			username	: username,
			domain	: domain,
			resource	: resource + randomstring(),			//to avoid resource-conflict as much a possible
			toString	: function() {
						return this.username + "@" + this.domain + "/" + this.resource;
					  }
		  };
}
exports.createJID = createJID;

var randomstring = function()
{
	var l = 5 + Math.floor(Math.random() * 5);
	var chars = "0123456789qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM";
	var str = "";
	for(var i = 0;i < l;i++)
	{
		var n = Math.floor(Math.random() * chars.length);
		str += chars.substr(n, 1);
	}
	return str;
}
exports.randomstring = randomstring;

exports.xmlhttprequest = function(options, cb, body)
{
	var hr = http.request(options, function(response){
		var xdata = "";
		response.on('data', function(chunk){
			xdata += chunk.toString();
		});
		response.on('end', function(){
			logit("DEBUG", "response: " + xdata);
			cb(false, xdata);
		});
		response.on('error', function(ee){
			cb(true, ee.toString());
		});
	});
	hr.setHeader("Connection", "Keep-Alive");
	hr.on('error', function(ee){
		cb(true, ee.toString());
	});
	logit("DEBUG", "request: " + body);
	if(body)
	{
		hr.setHeader("Content-Type", "text/xml; charset=utf-8");
		hr.setHeader("Content-Length", body.length.toString());
		hr.write(body);
	}
	hr.end();
}

var loglevel = "INFO";
exports.setloglevel = function(ss)
{
	ss = ss.toUpperCase();
	if(!loglevels[ss])
		ss = "INFO";
	loglevel = ss;
}
var loglevels = {
	FATAL	: 0,
	ERROR	: 1,
	DATA		: 2,
	INFO		: 3,
	DEBUG	: 4,
};
function logit(type, quote)
{
	//handle logging levels
	if(loglevels[type])
	{
		if(loglevels[type] <= loglevels[loglevel])
			console.log(type + ": " + quote);
	}
}
exports.logit = logit;

var msocket = [];	
exports.createSpareSockets = function(count, host, port)
{
	var i;
	for( i = 0;i < count; i++)
	{
		createSocket(i, port, host);
	}
}
function createSocket(i, port, host)
{
		msocket[i] = net.createConnection(port, host);
		msocket[i].on('data', function(chunk){
			//can do something with the data arrived
			logit("ERROR", "Unexpected data arrived on an spare socket. Data: " + chunk);
		});
		msocket[i].on('error', function(exception){
			logit("ERROR", exception)
		});
		msocket[i].on('close', function(had_error){
			if(had_error)
				logit("ERROR", "Spare Socket Closed(Some transmission error)");
			else	
			{
				logit("INFO", "Spare Socket trying to get Closed");
				createSocket(i, port, host);	//creating again[must be closing due to inactivity]
			}
		});
}
