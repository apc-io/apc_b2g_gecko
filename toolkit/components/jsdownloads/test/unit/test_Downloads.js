/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests the functions located directly in the "Downloads" object.
 */

"use strict";

////////////////////////////////////////////////////////////////////////////////
//// Tests

/**
 * Tests that the createDownload function exists and can be called.  More
 * detailed tests are implemented separately for the DownloadsCore module.
 */
add_task(function test_createDownload()
{
  // Creates a simple Download object without starting the download.
  yield Downloads.createDownload({
    source: { uri: NetUtil.newURI("about:blank") },
    target: { file: getTempFile(TEST_TARGET_FILE_NAME) },
    saver: { type: "copy" },
  });
});

/**
 * Tests simpleDownload with nsIURI and nsIFile as arguments.
 */
add_task(function test_simpleDownload_uri_file_arguments()
{
  let targetFile = getTempFile(TEST_TARGET_FILE_NAME);
  yield Downloads.simpleDownload(TEST_SOURCE_URI, targetFile);
  yield promiseVerifyContents(targetFile, TEST_DATA_SHORT);
});

/**
 * Tests simpleDownload with DownloadSource and DownloadTarget as arguments.
 */
add_task(function test_simpleDownload_object_arguments()
{
  let targetFile = getTempFile(TEST_TARGET_FILE_NAME);
  yield Downloads.simpleDownload({ uri: TEST_SOURCE_URI },
                                 { file: targetFile });
  yield promiseVerifyContents(targetFile, TEST_DATA_SHORT);
});
