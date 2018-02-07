/* eslint no-console: "off" */
/* eslint strict:0 */
/* eslint no-param-reassign: "off" */

'use strict';

const spawn = require('child_process').spawn;
const express = require('express');
const bodyParser = require('body-parser');
const uuid = require('uuid/v1');
const fs = require('fs-extra');
const rl = require('readline');

const VG_PATH = './vg/';
const MOUNTED_DATA_PATH = './mountedData/';
const INTERNAL_DATA_PATH = './internalData/';

const app = express();
app.use(bodyParser.json()); // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({ // to support URL-encoded bodies
  extended: true,
}));

// required for local usage (access docker container from outside)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(express.static('public'));

app.post('/chr22_v4', (req, res) => {
  console.log('http POST chr22_v4 received');
  console.log(`nodeID = ${req.body.nodeID}`);
  console.log(`distance = ${req.body.distance}`);

  // Assign each request a UUID. v1 UUIDs can be very similar for similar
  // timestamps on the same node, but are still guaranteed to be unique within
  // a given nodejs process.
  req.uuid = uuid();
  
  // Make a temp directory for vg output files for this request
  req.tempDir = `./tmp-${req.uuid}`
  fs.mkdirSync(req.tempDir);

  // We always have an XG file
  const xgFile = req.body.xgFile;
  
  // We sometimes have a GAM index with reads
  const gamIndex = req.body.gamIndex;
  req.withGam = true;
  if (!gamIndex || gamIndex === 'none') {
    req.withGam = false;
    console.log('no gam index provided.');
  }
  
  // We sometimes have a GBWT with haplotypes that override any in the XG
  const gbwtFile = req.body.gbwtFile;
  req.withGbwt = true;
  if (!gbwtFile || gbwtFile === 'none') {
    req.withGbwt = false;
    console.log('no gbwt file provided.');
  }

  // What path should be our anchoring path?
  const anchorTrackName = req.body.anchorTrackName;
  
  // Decide where to pull the data from (builtin examples or user data)
  const useMountedPath = req.body.useMountedPath;
  const dataPath = useMountedPath === 'true' ? MOUNTED_DATA_PATH : INTERNAL_DATA_PATH;
  console.log(`dataPath = ${dataPath}`);

  // call 'vg chunk' to generate graph
  let vgChunkParams = ['chunk', '-x', `${dataPath}${xgFile}`];
  if (req.withGam) {
    // Use a GAM index
    vgChunkParams.push('-a', `${dataPath}${gamIndex}`, '-g', '-A')
  }
  if (req.withGbwt) {
    // Use a GBWT haplotype database
    vgChunkParams.push('--gbwt-name', `${dataPath}${gbwtFile}`)
  }
  const position = Number(req.body.nodeID);
  const distance = Number(req.body.distance);
  if (Object.prototype.hasOwnProperty.call(req.body, 'byNode') && req.body.byNode === 'true') {
    vgChunkParams.push('-r', position, '-c', distance);
  } else {
    vgChunkParams.push('-c', '20', '-p', `${anchorTrackName}:${position}-${position + distance}`);
  }
  vgChunkParams.push('-T', '-b', `${req.tempDir}/chunk`, '-E', `${req.tempDir}/regions.tsv`);

  const vgChunkCall = spawn(`${VG_PATH}vg`, vgChunkParams);
  const vgViewCall = spawn(`${VG_PATH}vg`, ['view', '-j', '-']);
  let graphAsString = '';

  vgChunkCall.stderr.on('data', (data) => {
    console.log(`vg chunk err data: ${data}`);
  });

  vgChunkCall.stdout.on('data', function (data) {
    vgViewCall.stdin.write(data);
  });

  vgChunkCall.on('close', (code) => {
    console.log(`vg chunk exited with code ${code}`);
    vgViewCall.stdin.end();
  });

  vgViewCall.stderr.on('data', (data) => {
    console.log(`vg view err data: ${data}`);
  });

  vgViewCall.stdout.on('data', function (data) {
    graphAsString += data.toString();
  });

  vgViewCall.on('close', (code) => {
    console.log(`vg view exited with code ${code}`);
    if (graphAsString === '') {
      returnError(req, res);
      return;
    }
    req.graph = JSON.parse(graphAsString);
    processAnnotationFile(req, res);
  });
});

function returnError(req, res) {
  console.log('returning error');
  res.json({});
  // Clean up the temp directory for the request recursively
  fs.remove(req.tempDir);
}

function processAnnotationFile(req, res) {
  // find annotation file
  // TODO: This is not going to work if multiple people hit the server at once!
  // We need to make vg chunk take an argument from us for where to put the file.
  console.log('process annotation');
  fs.readdirSync(req.tempDir).forEach((file) => {
    if (file.substr(file.length - 12) === 'annotate.txt') {
      req.annotationFile = req.tempDir + '/' + file;
    }
  });

  if (!req.hasOwnProperty('annotationFile') || typeof req.annotationFile === 'undefined') {
    returnError(req, res);
    return;
  }
  console.log(`annotationFile: ${req.annotationFile}`);

  // read annotation file
  const lineReader = rl.createInterface({
    input: fs.createReadStream(req.annotationFile),
  });

  let i = 0;
  lineReader.on('line', (line) => {
    const arr = line.replace(/\s+/g, ' ').split(' ');
    if (req.graph.path[i].name === arr[0]) {
      req.graph.path[i].freq = arr[1];
    } else {
      console.log('Mismatch');
    }
    i += 1;
  });

  lineReader.on('close', () => {
    if (req.withGam === true) {
      processGamFile(req, res);
    } else {
      processRegionFile(req, res);
    }
  });
}

function processGamFile(req, res) {
  // Find gam file
  fs.readdirSync(req.tempDir).forEach((file) => {
    if (file.substr(file.length - 3) === 'gam') {
      req.gamFile = req.tempDir + '/' + file;
    }
  });

  // call 'vg view' to transform gam to json
  const vgViewChild = spawn(`${VG_PATH}vg`, ['view', '-j', '-a', req.gamFile]);

  vgViewChild.stderr.on('data', (data) => {
    console.log(`err data: ${data}`);
  });

  let gamJSON = '';
  vgViewChild.stdout.on('data', function (data) {
    gamJSON += data.toString();
  });

  vgViewChild.on('close', () => {
    req.gamArr = gamJSON
      .split('\n')
      .filter(function(a) {
        return a != '';
      })
      .map(function(a) {
        return JSON.parse(a);
      });
    processRegionFile(req, res);
  });
}

function processRegionFile(req, res) {
  const lineReader = rl.createInterface({
    input: fs.createReadStream('regions.tsv'),
  });

  lineReader.on('line', (line) => {
    const arr = line.replace(/\s+/g, ' ').split(' ');
    req.graph.path.forEach((path) => {
      if (path.name === arr[0]) path.indexOfFirstBase = arr[1];
    });
  });

  lineReader.on('close', () => {
    cleanUpAndSendResult(req, res);
  });
}

function cleanUpAndSendResult(req, res) {
  fs.unlink(req.annotationFile);
  if (req.withGam === true) {
    fs.unlink(req.gamFile);
  }
  // Clean up the temp directory for the request recursively (even though it should be empty)
  fs.remove(req.tempDir);

  const result = {};
  result.graph = req.graph;
  result.gam = req.withGam === true ? req.gamArr : [];
  res.json(result);
}

app.post('/getFilenames', (req, res) => {
  console.log('received request for filenames');
  const result = {
    xgFiles: [],
    gbwtFiles: [],
    gamIndices: [],
  };

  fs.readdirSync(MOUNTED_DATA_PATH).forEach((file) => {
    if (file.endsWith('.xg')) {
      result.xgFiles.push(file);
    }
    if (file.endsWith('.gbwt')) {
      result.gbwtFiles.push(file);
    }
    if (file.endsWith('.gam.index')) {
      result.gamIndices.push(file);
    }
  });

  console.log(result);
  res.json(result);
});

app.post('/getPathNames', (req, res) => {
  console.log('received request for pathNames');
  const result = {
    pathNames: [],
  };

  // call 'vg paths' to get path name information
  const vgViewChild = spawn(`${VG_PATH}vg`, ['paths', '-X', `${MOUNTED_DATA_PATH}${req.body.xgFile}`]);

  vgViewChild.stderr.on('data', (data) => {
    console.log(`err data: ${data}`);
  });

  let pathNames = '';
  vgViewChild.stdout.on('data', function (data) {
    pathNames += data.toString();
  });

  vgViewChild.on('close', () => {
    result.pathNames = pathNames.split('\n').filter(function(a) {
      return a != '';
    });
    console.log(result);
    res.json(result);
  });
});

app.listen(3000, () => console.log('TubeMapServer listening on port 3000!'));
