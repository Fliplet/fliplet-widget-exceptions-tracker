Fliplet.Widget.autosize();
Fliplet.Studio.emit('widget-save-label-update', {text: ''});

var data = Fliplet.Widget.getData();
if (data.dsn) {
  var position = data.dsn.indexOf('@');
  var dsn = [
    data.dsn.slice(0, position),
    ':' + data.private.secretKey,
    data.dsn.slice(position)
  ].join('');
  $('#dsn').val(dsn);
}

// Fired from Fliplet Studio when the external save button is clicked
Fliplet.Widget.onSaveRequest(function saveSettings() {
  var dsn = ''; // $('#dsn').val(); Use this to enable clients set own tracker
  if (dsn !== '') {
    var regex = /https:\/\/([a-z0-9]+):([a-z0-9]+)@sentry.io\/[0-9]+/g;
    var match = regex.exec(dsn);
    if (!match || match.length !== 3) {
      return Fliplet.Navigate.popup({
        popupMessage: '- Confirm your DSN. DSN must include the secret key.',
        popupTitle: 'Invalid settings'
      });
    }

    var data = {
      dsn: dsn.replace(':' + match[2], ''),
      private: {
        secretKey: match[2]
      }
    };
  } else {
    data = {
      dsn: null,
      private: {}
    }
  }

  Fliplet.Widget.save(data).then(Fliplet.Widget.complete);
});
