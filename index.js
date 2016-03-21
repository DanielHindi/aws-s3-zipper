var assert = require('assert');
var archiver = require('archiver');
var async = require('async');
var AWS = require('aws-sdk');
var fs = require('fs');




function S3Zipper(awsConfig) {
    assert.ok(awsConfig, 'AWS S3 options must be defined.');
    assert.notEqual(awsConfig.accessKeyId, undefined, 'Requires S3 AWS Key.');
    assert.notEqual(awsConfig.secretAccessKey, undefined, 'Requires S3 AWS Secret');
    assert.notEqual(awsConfig.region, undefined, 'Requires AWS S3 region.');
    assert.notEqual(awsConfig.bucket, undefined, 'Requires AWS S3 bucket.');
    this.init(awsConfig);
}
S3Zipper.prototype = {
    init: function (awsConfig) {
        this.awsConfig = awsConfig;
        AWS.config.update({
            accessKeyId: awsConfig.accessKeyId,
            secretAccessKey: awsConfig.secretAccessKey,
            region: awsConfig.region
        });
        this.s3bucket = new AWS.S3({
            params: {
                Bucket: this.awsConfig.bucket
            }
        });

    }
    ,filterOutFiles: function(fileObj){
        return fileObj;
    }
    ,getFiles: function(folderName,startKey,maxFileCount,maxFileSize,callback){

        var bucketParams = {
            Bucket: this.awsConfig.bucket, /* required */
            Delimiter: "/",
            Prefix: folderName + "/"
        };
        if (startKey)
            bucketParams.Marker = startKey;

        if(typeof(maxFileCount) == "function" && typeof(callback) == "undefined"){
            callback=maxFileCount;
            maxFileCount = null;
        }
        else if(maxFileCount > 0)
            bucketParams.MaxKeys = maxFileCount;

        var t = this;
        this.s3bucket.listObjects(bucketParams, function (err, data) {
            if (err) {
                callback(err, null);
            } else {
                var result = [];
                var totalSizeOfPassedFiles=0;
                var lastScannedFile;
                for (var i = 0; i < data.Contents.length; i++) {

                    var passedFile = t.filterOutFiles(data.Contents[i]);

                    if(passedFile) {


                        if(maxFileSize && maxFileSize < passedFile.Size) {
                            console.warn('Single file size exceeds max allowed size', data.Contents[i].Size, '>', maxFileSize, passedFile);
                            if(result.length == 0){
                                console.warn('Will zip large file on its own', passedFile.Key);
                                result.push(passedFile);
                                totalSizeOfPassedFiles += passedFile.Size;
                            }
                            else
                                break;
                        }
                        else if(maxFileSize && totalSizeOfPassedFiles + data.Contents[i].Size > maxFileSize) {
                            console.log('Hit max size limit. Split fragment');
                            break;
                        }
                        else {
                            result.push(passedFile);
                            totalSizeOfPassedFiles += passedFile.Size;
                        }
                    }

                    lastScannedFile = data.Contents[i];
                }
                callback(null, {files:result,totalFilesScanned :data.Contents.length,lastScannedFile:lastScannedFile} );
            }
        });
    }
    ,streamZipDataTo: function (pipe,folderName, startKey,maxFileCount,maxFileSize, callback) {
        if (!folderName) {
            console.error('folderName required');
            return null;
        }


        if(typeof(startKey) == "function" && !callback ) {
            callback = startKey;
            startKey=null;
            maxFileCount = null;
        }else if(typeof(maxFileCount) == "function" && typeof(callback) == "undefined"){
            callback=maxFileCount;
            maxFileCount = null;
        }

        var zip = new archiver.create('zip');
        if(pipe) zip.pipe(pipe);

        var t= this;

        this.getFiles(folderName,startKey,maxFileCount,maxFileSize,function(err,clearedFiles){
            if(err)
                console.error(err);
            else{
                var files = clearedFiles.files;
                async.map(files,function(f,callback){
                    t.s3bucket.getObject({Bucket: t.awsConfig.bucket,Key: f.Key },function(err,data){
                        if(err)
                            callback(err);
                        else {
                            var name = f.Key.split("/");
                            name.shift();
                            name = name.join("/");
                            console.log('zipping ', name,'...');

                            zip.append(data.Body, {name:name});
                            callback(null, f);

                        }

                    });

                }, function(err,results){
                    zip.finalize();
                    zip.manifest = results;
                    callback(err,{
                        zip: zip,
                        zippedFiles: results,
                        totalFilesScanned:clearedFiles.totalFilesScanned,
                        lastScannedFile:clearedFiles.lastScannedFile
                    });

                });
            }
        });

    }
    ,uploadLocalFileToS3: function(localFileName, s3ZipFileName,callback){
        console.log('uploading ',s3ZipFileName,'...');
        var readStream = fs.createReadStream(localFileName);//tempFile

        this.s3bucket.upload({
                Bucket: this.awsConfig.bucket
                , Key: s3ZipFileName
                , ContentType: "application/zip"
                , Body: readStream
            })
            .on('httpUploadProgress', function (e) {
                var p = Math.round(e.loaded / e.total * 1000) ;
                if(p % 25 == 0)
                    console.log('upload progress', p, '%');

            })
            .send(function (err, result) {
                readStream.close();
                if (err)
                    callback(err);
                else {
                    console.log('upload completed.');
                   callback(null,result);
                }
            });
    }
    //all these timeouts are because streams arent done writing when they say they are
    ,zipToS3File: function (s3FolderName,startKey,s3ZipFileName ,callback){
        var t = this;
        var tempFile = '__' + Date.now() + '.zip';

        if(s3ZipFileName.indexOf('/') < 0 )
            s3ZipFileName=s3FolderName + "/" + s3ZipFileName;


        this.zipToFile(s3FolderName,startKey,tempFile ,function(err,r){

            if(r && r.zippedFiles && r.zippedFiles.length) {
                t.uploadLocalFileToS3(tempFile,s3ZipFileName,function(err,result){
                    callback(null, {
                        zipFileETag: result.ETag,
                        zipFileLocation: result.Location,
                        zippedFiles: r.zippedFiles
                    });
                    fs.unlink(tempFile);
                });
            }
            else {
                console.log('no files zipped. nothing to upload');
                fs.unlink(tempFile);
                callback(null, {
                    zipFileETag: null,
                    zipFileLocation: null,
                    zippedFiles: []
                });
            }
        });


    }
    ,zipToS3FileFragments: function (s3FolderName, startKey, s3ZipFileName, maxFileCount, maxFileSize , callback){
        var t = this;
        var tempFile = '__' + Date.now() + '.zip';

        if(s3ZipFileName.indexOf('/') < 0 )
            s3ZipFileName=s3FolderName + "/" + s3ZipFileName;

        var finalResult;

        var count = 0;
        this.zipToFileFragments(s3FolderName,startKey,tempFile,maxFileCount,maxFileSize,function(err,result){
            if(err)
                callback(err);
            else
                finalResult=result;
        })
        .onFileZipped = function(fragFileName,result){
            var s3fn = s3ZipFileName.replace(".zip", "_" + count + ".zip" );
            count++;
            uploadFrag(s3fn,fragFileName,result);
        };

        var pendingUploads = 0;// prevent race condition
        function uploadFrag(s3FragName,localFragName,result){
            pendingUploads++;
            t.uploadLocalFileToS3(localFragName, s3FragName, function (err, uploadResult) {

                if(uploadResult){
                    result.uploadedFile = uploadResult;
                    console.log('remove temp file ',localFragName);
                    fs.unlink(localFragName);
                }
                pendingUploads--;
                if(pendingUploads == 0 && finalResult){
                    callback(null,finalResult);
                }
            });
        }


    }
    ,zipToFile: function (s3FolderName,startKey,zipFileName ,callback){
        var fileStream = fs.createWriteStream(zipFileName);
        this.streamZipDataTo(fileStream,s3FolderName,startKey,null,null,function(err,result){
            setTimeout(function(){
                callback(err,result);
                fileStream.close();
            },1000);
        });
    }
    ,zipToFileFragments: function (s3FolderName,startKey,zipFileName ,maxFileCount,maxFileSize,callback){


        var events = {
            onFileZipped:function(){}
        };

        var report ={
            results:[]
            ,errors:[]
            ,lastKey:null
        } ;

        if(maxFileSize && maxFileSize < 1024)
            console.warn ('Max File Size is really low. This may cause no files to be zipped, maxFileSize set to ',maxFileSize);

        if(zipFileName.indexOf(".zip") < 0)
            zipFileName+=".zip";

        var t= this;

        function garbageCollector(fileStream,result,fragFileName){

            setTimeout(function () {

                fileStream.close();
                if (result.zippedFiles.length == 0) /// its an empty zip file get rid of it

                    fs.unlink(fragFileName);

                else
                    events.onFileZipped(fragFileName,result);
            },1000); /// TODO: Zip needs a bit more time to finishing writing. I'm sure there is a better way
        }

        var counter = 0;
        function recursiveLoop(startKey,fragFileName ,callback) {
            var fileStream = fs.createWriteStream(fragFileName);
            t.streamZipDataTo(fileStream, s3FolderName, startKey, maxFileCount,maxFileSize, function (err, result) {

                if (err)
                    report.errors.push(err);
                else {
                    if (result.zippedFiles.length > 0) {
                        report.results.push(result);
                        report.lastKey = result.zippedFiles[result.zippedFiles.length - 1].Key;
                    }


                    /// you may have not zipped anything but you scanned files and there may be more
                    if(result.totalFilesScanned > 0)
                        recursiveLoop(result.lastScannedFile.Key, zipFileName.replace(".zip", "_" + counter + ".zip"), callback);
                    else ///you're done time to go home
                        callback(err, result);

                    counter++;
                    /// clean up your trash you filthy animal
                    garbageCollector(fileStream,result,fragFileName);

                }

            });
        }

        recursiveLoop(startKey,zipFileName ,function(){

                if (report.errors.length > 0)
                    callback(report.errors, report.results);
                else
                    callback(null, report.results);

        });

        return events;

    }
};

module.exports = S3Zipper;
