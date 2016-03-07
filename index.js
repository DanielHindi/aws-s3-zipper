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
    ,getFiles: function(folderName,startKey,callback){

        var bucketParams = {
            Bucket: this.awsConfig.bucket, /* required */
            Delimiter: "/",
            Prefix: folderName + "/"
            //MaxKeys: 50
        };
        if (startKey)
            bucketParams.Marker = startKey;

        var t = this;
        this.s3bucket.listObjects(bucketParams, function (err, data) {
            if (err) {
                callback(err, null);
            } else {
                var result = [];
                for (var i = 0; i < data.Contents.length; i++) {
                    var passedFile = t.filterOutFiles(data.Contents[i]);
                    if(passedFile)
                        result.push(passedFile);
                }
                callback(null, result);
            }
        });
    }
    ,streamZipDataTo: function (pipe,folderName, startKey, callback) {
        if (!folderName) {
            console.error('folderName required');
            return null;
        }

        if(typeof(startKey) == "function" && !callback ) {
            callback = startKey;
            startKey=null;
        }

        var zip = new archiver.create('zip');
        if(pipe) zip.pipe(pipe);

        var t= this;

        this.getFiles(folderName,startKey,function(err,files){
            if(err)
                console.error(err);
            else{
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
                    callback(err,zip);

                });
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
            console.log('uploading ',s3ZipFileName,'...');

            if(r && r.manifest && r.manifest.length) {
                var readStream = fs.createReadStream(tempFile);//tempFile

                t.s3bucket.upload({
                        Bucket: t.awsConfig.bucket
                        , Key: s3ZipFileName
                        , ContentType: "application/zip"
                        , Body: readStream
                    })
                    .on('httpUploadProgress', function (e) {
                        console.log('upload progress', Math.round(e.loaded / e.total * 100, 0), '%');

                    })
                    .send(function (err, result) {
                        readStream.close();
                        if (err)
                            callback(err);
                        else {
                            console.log('zip upload completed.');

                            callback(null, {
                                zipFileETag: result.ETag,
                                zipFileLocation: result.Location,
                                zippedFiles: r.manifest
                            });
                            fs.unlink(tempFile);
                        }
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
    ,zipToFile: function (s3FolderName,startKey,zipFileName ,callback){
        var fileStream = fs.createWriteStream(zipFileName);
        this.streamZipDataTo(fileStream,s3FolderName,startKey,function(err,result){
            setTimeout(function(){
                callback(err,result);
                fileStream.close();
            },1000);
        });
    }

};

module.exports = S3Zipper;
