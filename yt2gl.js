#!/usr/bin/env node

var fs = require('fs');
var util = require('util');
var colors = require('colors');
var csv = require('csv');
var rest = require('restler');
var async = require('async');
var _ = require('underscore');
var argv = require('optimist')
    .demand(['i', 'u', 'g', 'p', 't'])
    .alias('i', 'input')
    .alias('u', 'users')
    .alias('g', 'gitlaburl')
    .alias('p', 'project')
    .alias('t', 'token')
    .describe('i', 'CSV file exported from YouTrack (Example: issues.csv)')
    .describe('u', 'User mapping file (Example: users.json)')
    .describe('g', 'GitLab URL hostname (Example: gitlab.example.com)')
    .describe('p', 'GitLab project name including namespace (Example: mycorp/myproj)')
    .describe('t', 'An admin user\'s private token (Example: a2r33oczFyQzq53t23Vj)')
    .argv;

var inputFile = __dirname + '/' + argv.input;
var usersFile = __dirname + '/' + argv.users;
var gitlabAPIURLBase = 'http://' + argv.gitlaburl + '/api/v3';
var gitlabProjectName = argv.project;
var gitlabAdminPrivateToken = argv.token;

getGitLabProject(gitlabProjectName, gitlabAdminPrivateToken, function(error, project) {
  if (error) {
    console.error('Error: Cannot get list of projects from gitlab: ' + gitlabAPIURLBase);
    return;
  }

  if (!project) {
    console.error('Error: Cannot find GitLab project: ' + gitlabProjectName);
    return;
  }

  getGitLabUsers(gitlabAdminPrivateToken, function(error, gitlabUsers) {
    if (error) {
      console.error('Error: Cannot get list of users from gitlab: ' + gitlabAPIURLBase);
      return;
    }

    getUsers(usersFile, function(error, users) {
      if (error) {
        console.error('Error: Cannot read users file: ' + usersFile);
        return;
      }

      setGitLabUserIds(users, gitlabUsers);

      readRows(inputFile, function(error, rows) {
        if (error) {
          console.error('Error: Cannot read input file: ' + inputFile);
          return;
        }

        validate(rows, users, function(missingUsernames, missingNames) {
          if (missingUsernames.length > 0 || missingNames.length > 0) {
            for (var i = 0; i < missingUsernames.length; i++)
              console.error('Error: Cannot map YouTrack user with username: ' + missingUsernames[i]);

            for (var i = 0; i < missingNames.length; i++)
              console.error('Error: Cannot map YouTrack user with name: ' + missingNames[i]);

            return;
          }

          rows = _.sortBy(rows, function(row) { return Date.parse(row.Created); })

          async.eachSeries(rows, function(row, callback) {
            var issueId = row['Issue Id'];
            var title = row.Summary;
            var description = row.Description + (row.Description ? '\n' : '') + issueId;
            var assignee = getUserByYouTrackUsername(users, row.Assignee);
            var milestoneId = '';
            var labels = getLabels(row.Tags, row.Type, row.Priority, row.Subsystem);
            var author = getUserByYouTrackName(users, row.Reporter);

            insertIssue(project.id, title, description, assignee.gl_id, milestoneId, labels, author.gl_id, gitlabAdminPrivateToken, function(error, issue) {
              setTimeout(callback, 1000);

              if (error) {
                console.error((issueId + ': Failed to insert.').red);
                return;
              }

              if (isClosed(row.State)) {
                closeIssue(issue, assignee.gl_private_token || gitlabAdminPrivateToken, function(error) {
                  if (error)
                    console.warn((issueId + ': Inserted successfully but failed to close. #' + issue.iid).yellow);
                  else
                    console.error((issueId + ': Inserted and closed successfully. #' + issue.iid).green);
                });

                return;
              }

              console.log((issueId + ': Inserted successfully. #' + issue.iid).green);
            });
          });
        });
      });
    });
  });
})

function getGitLabProject(name, privateToken, callback) {
  var url = gitlabAPIURLBase + '/projects';
  var data = { per_page: 100, private_token: privateToken };

  rest.get(url, {data: data}).on('complete', function(result, response) {
    if (util.isError(result)) {
      callback(result);
      return;
    }

    if (response.statusCode != 200) {
      callback(result);
      return;
    }

    for (var i = 0; i < result.length; i++) {
      if (result[i].path_with_namespace === name) {
        callback(null, result[i]);
        return;
      }
    };

    callback(null, null);
  });
}

function getGitLabUsers(privateToken, callback) {
  var url = gitlabAPIURLBase + '/users';
  var data = { per_page: 100, private_token: privateToken };

  rest.get(url, {data: data}).on('complete', function(result, response) {
    if (util.isError(result)) {
      callback(result);
      return;
    }

    if (response.statusCode != 200) {
      callback(result);
      return;
    }

    callback(null, result);
  });
}

function getUsers(usersFile, callback) {
  fs.readFile(usersFile, {encoding: 'utf8'}, function(error, data) {
    if (error) {
      callback(error);
      return;
    }

    var users = JSON.parse(data);
    users.push({ yt_username: 'Unassigned' });

    callback(null, users);
  });
}

function setGitLabUserIds(users, gitlabUsers) {
  for (var i = 0; i < users.length; i++) {
    for (var j = 0; j < gitlabUsers.length; j++) {
      if (users[i].gl_username === gitlabUsers[j].username) {
        users[i].gl_id = gitlabUsers[j].id;
        break;
      }
    };
  };
}

function readRows(inputFile, callback) {
  fs.readFile(inputFile, {encoding: 'utf8'}, function(error, data) {
    if (error) {
      callback(error);
      return;
    }

    var rows = [];

    csv().from(data, {delimiter: ',', escape: '"', columns: true})
    .on('record', function(row, index) { rows.push(row) })
    .on('end', function() { callback(null, rows) });
  });
}

function validate(rows, users, callback) {
  var missingUsername = [];
  var missingNames = [];

  for (var i = 0; i < rows.length; i++) {
    var assignee = rows[i].Assignee;

    if (!getUserByYouTrackUsername(users, assignee) && missingUsername.indexOf(assignee) == -1)
      missingUsername.push(assignee);
  }

  for (var i = 0; i < rows.length; i++) {
    var reporter = rows[i].Reporter;

    if (!getUserByYouTrackName(users, reporter) && missingNames.indexOf(reporter) == -1)
      missingNames.push(reporter);
  }

  callback(missingUsername, missingNames);
}

function getUserByYouTrackUsername(users, username) {
  for (var i = 0; i < users.length; i++)
    if (users[i].yt_username == username)
      return users[i];

  return null;
}

function getUserByYouTrackName(users, name) {
  for (var i = 0; i < users.length; i++)
    if (users[i].yt_name == name)
      return users[i];

  return null;
}

function getLabels(tags, type, priority, subsystem) {
  var labels = (tags || []).slice(0);

  if (type && type !== 'Task')
    labels.push('type:' + type.toLowerCase());

  if (priority && priority !== 'Normal')
    labels.push('priority:' + priority.toLowerCase());

  if (subsystem && subsystem !== 'No subsystem')
    labels.push('subsystem:' + subsystem.toLowerCase());

  return labels.join(",");
}

function isClosed(state) {
  return ['Can\'t Reproduce', 'Duplicate', 'Fixed', 'Won\'t fix', 'Incomplete', 'Obsolete', 'Verified', 'Rejected'].indexOf(state) > -1;
}

function insertIssue(projectId, title, description, assigneeId, milestoneId, labels, creatorId, privateToken, callback) {
  var url = gitlabAPIURLBase + '/projects/' + projectId + '/issues';
  var data = {
    title: title,
    description: description,
    assignee_id: assigneeId,
    milestone_id: milestoneId,
    labels: labels,
    sudo: creatorId,
    private_token: privateToken,
  };

  rest.post(url, {data: data}).on('complete', function(result, response) {
    if (util.isError(result)) {
      callback(result);
      return;
    }

    if (response.statusCode != 201) {
      callback(result);
      return;
    }

    callback(null, result);
  });
}

function closeIssue(issue, privateToken, callback) {
  var url = gitlabAPIURLBase + '/projects/' + issue.project_id + '/issues/' + issue.id;
  var data = {
    state_event: 'close',
    private_token: privateToken,
  };

  rest.put(url, {data: data}).on('complete', function(result, response) {
    if (util.isError(result)) {
      callback(result);
      return;
    }

    if (response.statusCode != 200) {
      callback(result);
      return;
    }

    callback(null);
  });
}
