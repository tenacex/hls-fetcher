var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var fetch = require('fetch');
var parse = require('./parse.js');
var async = require('async');
var decrypter = require('./decrypter.js')
var Buffer = require('buffer');

var DEFAULT_CONCURRENCY = 5;
var usingEncryption = false;
var keyUri;
var encryptionIV;

function unicodeStringToTypedArray(s) {
    var escstr = encodeURIComponent(s);
    var binstr = escstr.replace(/%([0-9A-F]{2})/g, function(match, p1) {
        return String.fromCharCode('0x' + p1);
    });
    var ua = new Uint8Array(binstr.length);
    Array.prototype.forEach.call(binstr, function (ch, i) {
        ua[i] = ch.charCodeAt(0);
    });
    return ua;
}


function getCWDName (parentUri, localUri) {
  // Do I need to use node's URL object?
  var parentPaths = path.dirname(parentUri).split('/');
  var localPaths = path.dirname(localUri).split('/');

  var lookFor = parentPaths.pop();
  var i = localPaths.length;

  while (i--) {
    if (localPaths[i] === lookFor) {
      break;
    }
  }

  // No unique path-part found, use filename
  if (i === localPaths.length - 1) {
    return path.basename(localUri, path.extname(localUri));
  }

  return localPaths.slice(i + 1).join('_');
}

function createManifestText (manifest, rootUri) {
  return manifest.map(function (line) {
    if (line.type === 'playlist') {
      var subCWD = getCWDName(rootUri, line.line);
      return subCWD + '/' + path.basename(line.line);
    } else if (line.type === 'segment') {
      return path.basename(line.line);
    } else if (line.line.match(/^#EXT-X-KEY/i)) {
      //we are using encryption!!!!!!
      usingEncryption = true;
      var newLine = line.line.split(':')[1];
      newLine = newLine.split(',');
        for (var i = 0; i < newLine.length; i++){
          if (newLine[i].indexOf('IV=') != -1) {
          encryptionIV = newLine[i].substring(3, newLine[i].length);
        } else if (newLine[i].indexOf('URI=')) {
          keyUri = newLine[i].substring(5, newLine[i].length - 1);
        }
      }
    }
    return line.line;
  }).join('\n');
}

function getIt (options, done) {
  var uri = options.uri;
  var cwd = options.cwd;
  var concurrency = options.concurrency || DEFAULT_CONCURRENCY;
  var query = options.query;
  var playlistFilename = path.basename(uri);
  
  // Fetch playlist
  fetch.fetchUrl(uri, function getPlaylist (err, meta, body) {
    if (err) {
      console.error('Error fetching url:', uri);
      return done(err);
    }

    // Parse playlist
    var manifest = parse.parseManifest(uri, body.toString());

    // Save manifest
    fs.writeFileSync(path.resolve(cwd, playlistFilename), createManifestText(manifest, uri));

    var segments = manifest.filter(function (resource) {
      return resource.type === 'segment';
    });
    var playlists = manifest.filter(function (resource) {
      return resource.type === 'playlist';
    });

    async.series([
      function fetchSegments (next) {
        async.eachLimit(segments, concurrency, function (resource, done) {
          var filename = path.basename(resource.line);

          console.log('Start fetching', resource.line);
          
          // Fetch it to CWD (streaming)

          var segmentStream = new fetch.FetchStream(resource.line);
          
          //removes query parameters from filename
          if (filename.indexOf('?') !== -1 && query == 'yes') {
            console.log("Removing query parameters from file name.");
            filename = filename.split('?').shift();
          }

          var outputStream = fs.createWriteStream(path.resolve(cwd, filename));

          segmentStream.pipe(outputStream);

          segmentStream.on('error', function (err) {
            console.error('Fetching of url:', resource.line);
            return done(err);
          });

          segmentStream.on('end', function () {
            console.log('Finished fetching', resource.line);
            if (usingEncryption) {


              
              var encryptedFile = fs.readFileSync(path.resolve(cwd, filename), 'hex');
              var encryptedArray = unicodeStringToTypedArray(encryptedFile);
              var decryptedFile = decrypter.decrypt(encryptedArray, keyUri, encryptionIV);
              fs.writeFile(path.resolve(cwd, filename), decryptedFile, function (err) { 

                if (err) throw err; 
              });
            }
            return done();
          });
        }, next);
      },
      function fetchPlaylists (next) {
        async.eachSeries(playlists, function (resource, done) {
          // Create subCWD from URI
          var subCWD = getCWDName(uri, resource.line);
          var subDir = path.resolve(cwd, subCWD);

          // If subCWD does not exist, make subCWD (mkdirp)
          mkdirp(subDir, function (err) {
            if (err) {
              console.error('Error creating output path:', subDir);
              return done(err);
            }

            // Call `getIt` with subCWD and resource uri
            getIt({
              cwd: subDir,
              uri: resource.line,
              concurrency: concurrency
              },
              done);
          });
        }, next);
      }
    ], done);
  });
}





var exported = {getIt:getIt, createManifestText:createManifestText, getCWDName:getCWDName};
module.exports = exported;

//module.exports = getIt;
