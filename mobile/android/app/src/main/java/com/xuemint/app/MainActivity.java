package com.xuemint.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackupEnginePlugin.class);
        super.onCreate(savedInstanceState);
        // Keep the background safety-net pass scheduled whenever the app
        // opens, and it stays scheduled after a reboot on its own.
        BackupWorker.schedulePeriodic(this);
    }
}
